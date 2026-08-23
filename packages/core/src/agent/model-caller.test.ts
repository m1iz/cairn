import { describe, expect, it } from 'vitest'
import { createPlanDeltaThrottle } from './model-caller'

describe('plan_draft_delta write throttle (2026-07-05 B6)', () => {
  it('coalesces rapid full-snapshot deltas and trailing-flushes the final state', async () => {
    const emitted: Array<Record<string, unknown>> = []
    const throttle = createPlanDeltaThrottle(async (event) => {
      emitted.push(event)
    }, 100)

    for (let i = 1; i <= 50; i++) {
      await throttle.onDelta({
        index: 0,
        id: 'call_plan',
        name: 'propose_plan',
        argumentsText: JSON.stringify({
          title: `计划 v${i}`,
          summary: '第 ' + i + ' 版',
        }),
      })
    }
    await throttle.flush()

    // 同一 100ms 窗口内：首条立即发 + 尾部 flush 最终快照，中间 48 条全部合并
    expect(emitted.length).toBeLessThanOrEqual(3)
    const last = emitted.at(-1) as { interaction?: { title?: string } }
    expect(last.interaction?.title).toBe('计划 v50')
  })

  it('ignores non-plan deltas and empty snapshots', async () => {
    const emitted: Array<Record<string, unknown>> = []
    const throttle = createPlanDeltaThrottle(async (event) => {
      emitted.push(event)
    }, 100)
    await throttle.onDelta({
      index: 0,
      id: 'c',
      name: 'read_file',
      argumentsText: '{"path":"x"}',
    })
    await throttle.onDelta({
      index: 0,
      id: 'p',
      name: 'propose_plan',
      argumentsText: '{',
    })
    await throttle.flush()
    expect(emitted).toEqual([])
  })
})
