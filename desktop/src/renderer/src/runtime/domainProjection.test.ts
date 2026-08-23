import { describe, expect, it } from 'vitest'
import type { WsEvent } from '../types'
import {
  createDomainProjectionState,
  reduceDomainProjection,
} from './domainProjection'

describe('domain projection reducer', () => {
  it('applies the same Plan and Task events in sequence', () => {
    let state = createDomainProjectionState()
    state = reduceDomainProjection(state, {
      event: 'plan_runtime_update',
      seq: 1,
      plan: { id: 'plan-1', title: 'Plan', status: 'executing', steps: [] },
    } as WsEvent).state
    state = reduceDomainProjection(state, {
      event: 'task_started',
      seq: 2,
      task: { id: 'task-1', kind: 'plan_step', status: 'running' },
    } as WsEvent).state

    expect(state.plans.plans).toHaveLength(1)
    expect(state.tasks.tasks).toMatchObject([
      { id: 'task-1', status: 'running' },
    ])
  })

  it('rejects duplicate Task events regardless of their transport origin', () => {
    const initial = createDomainProjectionState()
    const event = {
      event: 'task_started',
      seq: 3,
      task: { id: 'task-1', kind: 'subagent', status: 'running' },
    } as WsEvent
    const first = reduceDomainProjection(initial, event)
    const duplicate = reduceDomainProjection(first.state, event)

    expect(first.accepted).toBe(true)
    expect(duplicate.accepted).toBe(false)
    expect(duplicate.state).toBe(first.state)
  })
})
