import { describe, expect, it } from 'vitest'
import type { ToolIntent } from './contracts'
import { planToolExecution } from './planner'

function intent(id: string, concurrencySafe: boolean): ToolIntent {
  return { id, name: id, arguments: {}, concurrencySafe }
}

describe('planToolExecution', () => {
  it('groups only consecutive safe calls and keeps exclusive barriers ordered', () => {
    expect(
      planToolExecution([
        intent('read-a', true),
        intent('read-b', true),
        intent('write', false),
        intent('read-c', true),
      ]).map((batch) => ({
        mode: batch.mode,
        ids: batch.calls.map((call) => call.id),
      })),
    ).toEqual([
      { mode: 'parallel', ids: ['read-a', 'read-b'] },
      { mode: 'exclusive', ids: ['write'] },
      { mode: 'parallel', ids: ['read-c'] },
    ])
  })

  it('rejects duplicate ids before anything can execute', () => {
    expect(() =>
      planToolExecution([intent('same', true), intent('same', false)]),
    ).toThrow('duplicate tool call id')
  })
})
