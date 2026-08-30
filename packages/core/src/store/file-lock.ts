import { open, readFile, stat, unlink } from 'node:fs/promises'

/**
 * 文件锁。
 *
 * 跨写者串行化（scheduler action log / external store 合并）。零依赖实现：用 O_EXCL
 * 独占创建 `*.lock` 文件作为互斥；支持 stale 锁回收与超时。后续如需更强可换 proper-lockfile。
 */

export interface LockOptions {
  /** 获取锁的总超时（ms）。 */
  timeoutMs?: number
  /** 锁文件超过该年龄视为 stale 可回收（ms）。 */
  staleMs?: number
  /** 重试间隔（ms）。 */
  retryMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function acquire(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const fh = await open(lockPath, 'wx')
    await fh.writeFile(String(process.pid))
    await fh.close()
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (!isLockContention(code)) throw err
    // Windows can briefly surface a competing create/open as EPERM, EACCES,
    // or EBUSY while another writer (or a filesystem filter) owns the path.
    // Those states are retryable but do not prove that a stale lock exists.
    if (code !== 'EEXIST') return false
    // 锁已存在：若 stale 则回收一次再让下一轮重试。
    try {
      const s = await stat(lockPath)
      if (
        Date.now() - s.mtimeMs > staleMs &&
        !(await lockOwnerIsAlive(lockPath))
      ) {
        await unlink(lockPath).catch(() => {})
      }
    } catch {
      // 锁文件刚好被别人释放，下一轮重试即可。
    }
    return false
  }
}

function isLockContention(code: string | undefined): boolean {
  return (
    code === 'EEXIST' ||
    (process.platform === 'win32' &&
      (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'))
  )
}

async function lockOwnerIsAlive(lockPath: string): Promise<boolean> {
  let pid = 0
  try {
    pid = Number.parseInt((await readFile(lockPath, 'utf8')).trim(), 10)
  } catch {
    return false
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 在 `targetPath` 对应的锁下执行 fn，结束后释放锁。 */
export async function withLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const lockPath = `${targetPath}.lock`
  const timeoutMs = opts.timeoutMs ?? 5000
  const staleMs = opts.staleMs ?? 30_000
  const retryMs = opts.retryMs ?? 25
  const deadline = Date.now() + timeoutMs

  while (!(await acquire(lockPath, staleMs))) {
    if (Date.now() > deadline) {
      throw new Error(`withLock: timed out acquiring ${lockPath}`)
    }
    await sleep(retryMs)
  }
  try {
    return await fn()
  } finally {
    await unlink(lockPath).catch(() => {})
  }
}
