import type { RuntimePlanRecord } from '../types'

const ACTIVE_STATUSES = new Set([
  'executing',
  'completed',
  'failed',
  'waiting_approval',
  'approved',
])

export function activeProjectPlan(
  plans: RuntimePlanRecord[] | undefined | null,
): RuntimePlanRecord | null {
  const candidates = (plans || []).filter((plan) =>
    ACTIVE_STATUSES.has(String(plan.status)),
  )
  if (!candidates.length) return null
  return candidates.reduce((best, plan) =>
    Number(plan.updated_at || 0) >= Number(best.updated_at || 0) ? plan : best,
  )
}

export function reviewerTaskId(
  plan: RuntimePlanRecord | null | undefined,
): string {
  const items = plan?.verification || []
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i] as Record<string, unknown> | null
    const source = typeof item?.source === 'string' ? item.source : ''
    if (
      source.startsWith('independent_verification') ||
      source.includes('reviewer')
    ) {
      const id = item?.task_id
      if (typeof id === 'string' && id.trim()) return id.trim()
    }
  }
  return ''
}
