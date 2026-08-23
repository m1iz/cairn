import type {
  HookAggregateDecision,
  HookDecision,
  HookExecutionResult,
} from './models'

const DECISION_PRIORITY: Record<HookDecision, number> = {
  passthrough: 0,
  allow: 1,
  ask: 2,
  deny: 3,
}
const MAX_CONTEXT_CHARS = 4_000

export function aggregateHookResults(
  results: HookExecutionResult[],
): HookAggregateDecision {
  const winner = [...results].sort(
    (a, b) => DECISION_PRIORITY[b.decision] - DECISION_PRIORITY[a.decision],
  )[0]
  const decision = winner?.decision ?? 'passthrough'
  const updates = results.filter(
    (result) => result.updatedInput && result.decision !== 'deny',
  )
  const aggregate: HookAggregateDecision = {
    decision,
    reason: winner?.reason ?? '',
    results,
    additionalContext: boundedContext(results),
  }
  if (decision !== 'deny' && updates.length === 1 && updates[0]?.updatedInput)
    aggregate.updatedInput = updates[0].updatedInput
  return aggregate
}

function boundedContext(results: HookExecutionResult[]): string {
  const chunks = results
    .filter((result) => result.additionalContext?.trim())
    .map((result) => `[${result.hookId}]\n${result.additionalContext}`)
  if (chunks.length === 0) return ''
  return chunks.join('\n\n').slice(0, MAX_CONTEXT_CHARS)
}
