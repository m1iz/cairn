import { describe, expect, it, vi } from 'vitest'
import { TeamRunController } from './runtime'

describe('TeamRunController', () => {
  it('enforces member, project, and global concurrency without affecting other projects', () => {
    const runtime = new TeamRunController({
      maxConcurrent: 3,
      maxConcurrentPerProject: 2,
      ttlMs: 10_000,
    })
    const alice = runtime.acquire({
      projectId: 'p1',
      memberName: 'alice',
      turnId: 't1',
    })
    runtime.acquire({ projectId: 'p1', memberName: 'bob', turnId: 't2' })
    expect(() =>
      runtime.acquire({ projectId: 'p1', memberName: 'carol', turnId: 't3' }),
    ).toThrow(/project concurrency/)
    runtime.acquire({ projectId: 'p2', memberName: 'carol', turnId: 't3' })
    expect(() =>
      runtime.acquire({ projectId: 'p3', memberName: 'dave', turnId: 't4' }),
    ).toThrow(/global concurrency/)
    expect(() =>
      runtime.acquire({ projectId: 'p1', memberName: 'alice', turnId: 't5' }),
    ).toThrow(/already working/)
    alice.release()
  })

  it('propagates parent cancellation and supports session/application shutdown', () => {
    const parent = new AbortController()
    const runtime = new TeamRunController({ ttlMs: 10_000 })
    const alice = runtime.acquire({
      projectId: 'p1',
      memberName: 'alice',
      turnId: 't1',
      sessionId: 's1',
      signal: parent.signal,
    })
    runtime.acquire({
      projectId: 'p2',
      memberName: 'bob',
      turnId: 't2',
      sessionId: 's2',
    })
    parent.abort('stop')
    expect(alice.signal.aborted).toBe(true)
    expect(runtime.cancelSession('s2')).toBe(1)
    expect(runtime.shutdown()).toBe(2)
    alice.release()
    expect(runtime.snapshot()).toHaveLength(1)
  })

  it('aborts runs that exceed TTL and releases capacity idempotently', () => {
    vi.useFakeTimers()
    try {
      const runtime = new TeamRunController({ ttlMs: 50 })
      const lease = runtime.acquire({
        projectId: 'p1',
        memberName: 'alice',
        turnId: 't1',
      })
      vi.advanceTimersByTime(50)
      expect(lease.signal.aborted).toBe(true)
      lease.release()
      lease.release()
      expect(runtime.snapshot()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
