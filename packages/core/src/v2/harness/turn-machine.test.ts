import { describe, expect, it } from 'vitest'
import { TurnMachine, turnPhaseRuntimeEvent } from './turn-machine'

describe('TurnMachine', () => {
  it('advances iteration and sequence independently and projects compatibility events', () => {
    const machine = new TurnMachine({ turnId: 'turn-1' })
    expect(machine.startIteration()).toBe(1)
    const event = machine.transition('model_request', { attempt: 1 })
    expect(event).toEqual({
      turnId: 'turn-1',
      phase: 'model_request',
      sequence: 1,
      iteration: 1,
      detail: { attempt: 1 },
    })
    expect(turnPhaseRuntimeEvent(event)).toEqual({
      event: 'turn_phase',
      phase: 'model_request',
      sequence: 1,
      iteration: 1,
      turn_id: 'turn-1',
      detail: { attempt: 1 },
    })
  })

  it('does not expose mutable state or detail references', () => {
    const machine = new TurnMachine()
    const detail = { nested: { value: 1 } }
    const event = machine.transition('checkpoint', detail)
    detail.nested.value = 2
    expect(event.detail).toEqual({ nested: { value: 1 } })
    const snapshot = machine.snapshot()
    snapshot.phase = 'forged'
    expect(machine.snapshot().phase).toBe('checkpoint')
  })
})
