import { existsSync } from 'node:fs'
import { mkdtemp, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { withLock } from './file-lock'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cairn-lock-'))
})

describe('withLock', () => {
  it('serializes concurrent critical sections', async () => {
    const target = join(dir, 'state.json')
    let active = 0
    let maxActive = 0
    const crit = async () =>
      withLock(target, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 15))
        active--
      })
    await Promise.all([crit(), crit(), crit()])
    expect(maxActive).toBe(1)
  })

  it('releases the lock after the section (even on throw)', async () => {
    const target = join(dir, 's.json')
    await expect(
      withLock(target, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(`${target}.lock`)).toBe(false)
  })

  it('reclaims a stale lock', async () => {
    const target = join(dir, 's.json')
    await writeFile(`${target}.lock`, '99999', 'utf8')
    // staleMs=0 → 立刻视为 stale 回收
    const out = await withLock(target, async () => 'ok', {
      staleMs: 0,
      timeoutMs: 1000,
    })
    expect(out).toBe('ok')
  })

  it('does not reclaim an old lock while its owner process is alive', async () => {
    const target = join(dir, 'live.json')
    const lockPath = `${target}.lock`
    await writeFile(lockPath, String(process.pid), 'utf8')
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    await expect(
      withLock(target, async () => 'unreachable', {
        staleMs: 0,
        timeoutMs: 50,
        retryMs: 5,
      }),
    ).rejects.toThrow('timed out acquiring')
    expect(existsSync(lockPath)).toBe(true)
    await unlink(lockPath)
  })
})
