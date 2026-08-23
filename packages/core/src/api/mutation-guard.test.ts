import { describe, expect, it } from 'vitest'
import {
  assertCoreMutationAllowed,
  CoreMutationGuardError,
} from './mutation-guard'

describe('mutation guard (MIG-IPC-008)', () => {
  it('allows direct user actions in ask_before_edit mode', () => {
    expect(() =>
      assertCoreMutationAllowed(
        { mode: 'ask_before_edit', pending: null },
        { area: 'scheduler', action: 'run' },
      ),
    ).not.toThrow()
  })

  it('rejects mutations while Ask / Plan is pending', () => {
    expect(() =>
      assertCoreMutationAllowed(
        { mode: 'ask_before_edit', pending: { id: 'ask_1' } },
        { area: 'team', action: 'wake teammate' },
      ),
    ).toThrow(CoreMutationGuardError)
    try {
      assertCoreMutationAllowed(
        { mode: 'ask_before_edit', pending: { id: 'ask_1' } },
        { area: 'team', action: 'wake teammate' },
      )
    } catch (error) {
      expect(error).toMatchObject({ status: 409 })
    }
  })

  it('rejects plan mode mutations', () => {
    try {
      assertCoreMutationAllowed(
        { mode: 'plan', pending: null },
        { area: 'scheduler', action: 'create' },
      )
    } catch (error) {
      expect(error).toMatchObject({ status: 403 })
      expect(String((error as Error).message)).toContain(
        'Cannot create scheduler in plan mode',
      )
    }
  })
})
