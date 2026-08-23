import { planToDict, type PlanRecord } from '../../plans/models'

export type PlanPayload = Record<string, unknown>

export interface ReadonlyPlanStore {
  list(): PlanRecord[]
  get(planId: string): PlanRecord | null
}

/** Read-only application service for the public Plan query surface. */
export class CorePlanService {
  constructor(private readonly store: ReadonlyPlanStore) {}

  list(): PlanPayload[] {
    return this.store.list().map(planToDict)
  }

  get(planId: string): PlanPayload | null {
    const plan = this.store.get(planId)
    return plan ? planToDict(plan) : null
  }
}
