import { describe, expect, it } from 'vitest'
import { TurnPhase, TurnState } from './turn-state'

describe('TurnState', () => {
  it('advances iteration and sequence and projects runtime events', () => {
    const state = new TurnState({ turnId: 'turn-1' })
    expect(state.startIteration()).toBe(1)

    const event = state.transition(TurnPhase.MODEL_REQUEST, {
      detail: { attempt: 1 },
    })

    expect(event).toMatchObject({
      turnId: 'turn-1',
      phase: 'model_request',
      sequence: 1,
      iteration: 1,
      detail: { attempt: 1 },
    })
    expect(event.toRuntimeEvent()).toEqual({
      event: 'turn_phase',
      phase: 'model_request',
      sequence: 1,
      iteration: 1,
      turn_id: 'turn-1',
      detail: { attempt: 1 },
    })
  })

  it('does not retain mutable detail references', () => {
    const state = new TurnState()
    const detail = { nested: { value: 1 } }
    const event = state.transition(TurnPhase.CHECKPOINT, { detail })

    detail.nested.value = 2
    expect(event.detail).toEqual({ nested: { value: 1 } })
    expect(event.toRuntimeEvent()).toMatchObject({
      detail: { nested: { value: 1 } },
    })
  })
})
