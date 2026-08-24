export interface PlanReviewerContext {
  readonly goalId: string
  readonly planId: string
  readonly planEventSeq: number
}

export interface PlanReviewerFact extends PlanReviewerContext {
  readonly kind: 'core_independent_plan_review'
  readonly issuedBy: 'core'
  readonly verdict: 'pass' | 'waived'
  readonly receiptId: string
  readonly commandEvidenceRefs: readonly string[]
}
