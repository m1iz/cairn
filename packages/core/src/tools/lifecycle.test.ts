import { describe, expect, it } from 'vitest'
import { authorizeToolIntent } from './contracts'
import { initialToolLifecycle, transitionToolLifecycle } from './lifecycle'

describe('tool lifecycle', () => {
  it('requires an allowed decision before creating an authorized call', () => {
    const intent = {
      id: 'call-1',
      name: 'read_file',
      arguments: { path: 'a.ts' },
      concurrencySafe: true,
    }
    expect(
      authorizeToolIntent(intent, { outcome: 'allowed', rule: 'read-only' }),
    ).toMatchObject({ authorizationRule: 'read-only' })
    expect(() =>
      authorizeToolIntent(intent, {
        outcome: 'denied',
        reason: 'outside workspace',
        rule: 'workspace',
      }),
    ).toThrow('tool intent is not authorized')
  })

  it('allows exactly one terminal observation', () => {
    const running = transitionToolLifecycle(initialToolLifecycle(), {
      type: 'started',
    })
    const completed = transitionToolLifecycle(running, {
      type: 'observed',
      observation: {
        status: 'completed',
        summary: 'done',
        output: 'ok',
        metadata: {},
      },
    })
    expect(completed).toMatchObject({ phase: 'completed', terminalCount: 1 })
    expect(
      transitionToolLifecycle(completed, {
        type: 'observed',
        observation: { status: 'cancelled', reason: 'late abort' },
      }),
    ).toBe(completed)
  })

  it('rejects invalid double starts', () => {
    const running = transitionToolLifecycle(initialToolLifecycle(), {
      type: 'started',
    })
    expect(() => transitionToolLifecycle(running, { type: 'started' })).toThrow(
      'tool cannot start from executing',
    )
  })
})
