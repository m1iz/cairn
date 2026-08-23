import { open, stat, unlink } from 'node:fs/promises'

/**
 * 文件锁 (MIG-FND-003)。
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
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    // 锁已存在：若 stale 则回收一次再让下一轮重试。
    try {
      const s = await stat(lockPath)
      if (Date.now() - s.mtimeMs > staleMs) {
        await unlink(lockPath).catch(() => {})
      }
    } catch {
      // 锁文件刚好被别人释放，下一轮重试即可。
    }
    return false
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
