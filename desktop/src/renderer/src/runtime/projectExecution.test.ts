import { describe, expect, it } from 'vitest'
import { activeProjectPlan, reviewerTaskId } from './projectExecution'
import type { RuntimePlanRecord } from '../types'

describe('activeProjectPlan', () => {
  it('returns the most recent executing/completed plan, ignoring drafts', () => {
    const plans = [
      { id: 'a', status: 'draft', updated_at: 5 },
      { id: 'b', status: 'executing', updated_at: 10 },
    ] as unknown as RuntimePlanRecord[]
    expect(activeProjectPlan(plans)?.id).toBe('b')
  })

  it('returns null when only drafts exist', () => {
    const plans = [
      { id: 'a', status: 'draft', updated_at: 1 },
    ] as unknown as RuntimePlanRecord[]
    expect(activeProjectPlan(plans)).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(activeProjectPlan([])).toBeNull()
    expect(activeProjectPlan(undefined)).toBeNull()
  })
})

describe('reviewerTaskId', () => {
  it('extracts task id from latest independent_verification evidence', () => {
    const plan = {
      id: 'b',
      verification: [
        {
          source: 'verification_reviewer',
          passed: true,
          task_id: 'subagent_abc',
        },
      ],
    } as unknown as RuntimePlanRecord
    expect(reviewerTaskId(plan)).toBe('subagent_abc')
  })

  it('returns empty string when no reviewer task id', () => {
    expect(
      reviewerTaskId({
        id: 'b',
        verification: [],
      } as unknown as RuntimePlanRecord),
    ).toBe('')
    expect(reviewerTaskId(null)).toBe('')
  })
})
