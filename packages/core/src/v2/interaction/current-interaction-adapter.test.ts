import { describe, expect, it, vi } from 'vitest'
import { CurrentInteractionAdapter } from './current-interaction-adapter'

describe('CurrentInteractionAdapter', () => {
  it('maps typed interaction verbs to the current persisted control surface', async () => {
    const current = {
      get: vi.fn(() => ({ pending: null })),
      setMode: vi.fn((mode: string) => ({ mode })),
      setPermissionMode: vi.fn((permissionMode: string) => ({
        permissionMode,
      })),
      answerInteraction: vi.fn(async (id: string) => ({
        id,
        status: 'answered',
      })),
      commentPlan: vi.fn(async (id: string, comment: string) => ({
        id,
        comment,
      })),
      approvePlan: vi.fn(async (id: string) => ({ id, status: 'approved' })),
      cancelInteraction: vi.fn(async (id: string) => ({
        id,
        status: 'cancelled',
      })),
    }
    const adapter = new CurrentInteractionAdapter(current)

    expect(adapter.get()).toEqual({ pending: null })
    await expect(adapter.setMode('plan')).resolves.toEqual({ mode: 'plan' })
    await expect(adapter.setPermissionMode('smart_auto')).resolves.toEqual({
      permissionMode: 'smart_auto',
    })
    await expect(adapter.answer('ask-1', { answer: 'yes' })).resolves.toEqual({
      id: 'ask-1',
      status: 'answered',
    })
    await expect(adapter.comment('plan-1', 'adjust')).resolves.toEqual({
      id: 'plan-1',
      comment: 'adjust',
    })
    await expect(adapter.approve('plan-1')).resolves.toMatchObject({
      status: 'approved',
    })
    await expect(adapter.cancel('ask-1')).resolves.toMatchObject({
      status: 'cancelled',
    })
  })
})
