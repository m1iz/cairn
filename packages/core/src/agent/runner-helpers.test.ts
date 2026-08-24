import { describe, expect, it } from 'vitest'
import {
  buildMaxTurnsSummary,
  currentPermissionAuthorization,
  currentTaskIntent,
  modelUsageTokens,
  positiveOptionalInt,
  progressPauseReason,
  sanitizeProviderMessage,
} from './runner-helpers'

describe('buildMaxTurnsSummary authority', () => {
  it('uses PlanStep as the sole completion authority and lists only independent Todos', () => {
    const summary = buildMaxTurnsSummary({
      maxTurns: 20,
      plan: {
        title: 'Implement feature',
        status: 'executing',
        steps: [
          { title: 'Implement', status: 'active' },
          { title: 'Verify', status: 'pending' },
        ],
      },
      todos: [
        {
          id: 'plan:step_1',
          plan_id: 'plan_1',
          plan_step_id: 'step_1',
          content: 'Implement',
          status: 'completed',
        },
        { id: 'scratch', content: '临时调查', status: 'completed' },
      ],
    })

    expect(summary).toContain('计划「Implement feature」步骤完成 0/2')
    expect(summary).toContain('临时待办完成 1/1')
    expect(summary).not.toContain('已完成 2/2')
    expect(summary).toContain('验证未完成')
    expect(summary).not.toContain('max_turns')
  })
})

describe('runner boundary helpers', () => {
  it('sanitizes provider messages and derives bounded runtime metadata', () => {
    expect(
      sanitizeProviderMessage({
        role: 'assistant',
        content: 'ok',
        tool_calls: [],
        internal: 'must-not-cross-provider-boundary',
      }),
    ).toEqual({ role: 'assistant', content: 'ok', tool_calls: [] })
    expect(positiveOptionalInt('12.9')).toBe(12)
    expect(positiveOptionalInt(0)).toBeNull()
    expect(modelUsageTokens({ input_tokens: 7, output_tokens: 5 })).toBe(12)
    expect(modelUsageTokens({ total_tokens: 20, input_tokens: 99 })).toBe(20)
  })

  it('reads only the latest ordinary user intent and exact permission receipt', () => {
    expect(
      currentTaskIntent([
        { role: 'user', content: 'implement this' },
        { role: 'user', content: '[CONTROL:PLAN_APPROVED]' },
      ]),
    ).toBe('implement this')
    expect(
      currentPermissionAuthorization([
        {
          role: 'user',
          content: '[CONTROL:PERMISSION_ANSWERED]\nauthorization_id: auth_123',
        },
      ]),
    ).toBe('auth_123')
    expect(
      currentPermissionAuthorization([{ role: 'user', content: 'chat' }]),
    ).toBeNull()
  })

  it('maps progress decisions to stable pause reasons', () => {
    expect(progressPauseReason('no_progress')).toBe('no_progress')
    expect(progressPauseReason('verification_remaining')).toBe(
      'verification_required',
    )
    expect(progressPauseReason('blocked')).toBe('continuation_rejected')
  })
})
