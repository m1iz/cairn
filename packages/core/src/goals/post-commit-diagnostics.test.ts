import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GoalPostCommitDiagnosticsStore } from './post-commit-diagnostics'

describe('GoalPostCommitDiagnosticsStore', () => {
  it('serializes concurrent writers under the state-root guard and leaves two durable records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-diagnostics-'))
    let active = 0
    let maxActive = 0
    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    let hookCalls = 0
    const hook = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      hookCalls += 1
      if (hookCalls === 1) {
        firstStarted()
        await firstCanFinish
      }
      active -= 1
    }
    const left = new GoalPostCommitDiagnosticsStore(root, {
      beforeAppend: hook,
    })
    const right = new GoalPostCommitDiagnosticsStore(root, {
      beforeAppend: hook,
    })
    const first = left.append({
      goalId: 'goal_diagnostics',
      code: 'plan_token_revoke_failed',
      occurredAt: '2026-07-16T00:00:00.000Z',
    })
    await firstDidStart
    const second = right.append({
      goalId: 'goal_diagnostics',
      code: 'runtime_event_emit_failed',
      occurredAt: '2026-07-16T00:00:01.000Z',
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(maxActive).toBe(1)
    releaseFirst()
    await Promise.all([first, second])

    const inspection = await left.inspect()
    expect(inspection.issue).toBeNull()
    expect(inspection.records).toHaveLength(2)
    expect(
      readdirSync(dirname(left.path)).filter((name) => name.includes('.tmp')),
    ).toEqual([])
  })
})
