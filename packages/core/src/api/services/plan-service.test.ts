import { describe, expect, it, vi } from 'vitest'
import { makePlanRecord, PlanStatus, type PlanRecord } from '../../plans/models'
import { CorePlanService } from './plan-service'

function plan(id: string): PlanRecord {
  return makePlanRecord({
    id,
    title: `Plan ${id}`,
    summary: '',
    status: PlanStatus.DRAFT,
    createdAt: 1,
    updatedAt: 1,
  })
}

describe('CorePlanService', () => {
  it('projects the store records without exposing mutable domain objects', () => {
    const stored = plan('plan-1')
    const service = new CorePlanService({
      list: vi.fn(() => [stored]),
      get: vi.fn(() => stored),
    })

    const listed = service.list()
    const found = service.get('plan-1')

    expect(listed).toEqual([found])
    expect(found).toMatchObject({ id: 'plan-1', status: 'draft' })
    expect(found).not.toBe(stored)
  })

  it('preserves a missing Plan as null', () => {
    const service = new CorePlanService({
      list: () => [],
      get: () => null,
    })

    expect(service.get('missing')).toBeNull()
  })
})
