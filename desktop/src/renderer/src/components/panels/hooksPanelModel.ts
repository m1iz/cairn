import type { HookEventMetadataPayload, HooksPayload } from '../../types'

export type HooksTone = 'ok' | 'warn' | 'error' | 'muted'

export interface EffectiveHookRow {
  key: string
  eventName: string
  groupId: string
  matcher: string
  condition: string
  failureMode: string
  handlerCount: number
  enabledHandlerCount: number
  handlerTypes: string[]
  sourceId: string
  sourceKind: string
  sourcePath: string
  readonly: boolean
  active: boolean
  blockedReason: string
}

export function effectiveHookRows(
  payload: HooksPayload | null | undefined,
): EffectiveHookRow[] {
  return (payload?.effectiveGroups ?? []).map((entry, index) => {
    const group = entry.group ?? {}
    const source = entry.source ?? {}
    const handlers = group.handlers ?? []
    const eventName = String(entry.eventName ?? '')
    const groupId = String(group.id ?? `group-${index + 1}`)
    return {
      key: `${eventName}:${String(source.id ?? source.kind ?? 'source')}:${groupId}`,
      eventName,
      groupId,
      matcher: String(group.matcher || '*'),
      condition: String(group.if || ''),
      failureMode: String(group.failureMode || 'open'),
      handlerCount: handlers.length,
      enabledHandlerCount: handlers.filter(
        (handler) => handler.enabled !== false,
      ).length,
      handlerTypes: handlers.map((handler) =>
        String(handler.type || 'unknown'),
      ),
      sourceId: String(source.id || source.kind || 'source'),
      sourceKind: String(source.kind || 'unknown'),
      sourcePath: String(source.path || ''),
      readonly: source.readonly === true,
      active: source.active !== false && group.enabled !== false,
      blockedReason: String(source.blockedReason || ''),
    }
  })
}

export function hooksTrustTone(status: unknown): HooksTone {
  if (status === 'trusted') return 'ok'
  if (status === 'untrusted') return 'warn'
  if (status === 'stale') return 'error'
  return 'muted'
}

export function dryRunInput(
  eventName: string,
  matcherField: string | null,
): Record<string, unknown> {
  if (
    [
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'PermissionDenied',
    ].includes(eventName)
  ) {
    return {
      tool_name: 'read_file',
      tool_input: { path: 'README.md' },
      tool_use_id: 'dry-run',
    }
  }
  if (eventName === 'ConfigChange')
    return { source: 'hooks.testMatch', candidate_revision: 'dry-run' }
  if (
    eventName === 'SubagentStart' ||
    eventName === 'SubagentStop' ||
    eventName === 'TeammateIdle'
  ) {
    return { agent_type: 'general-purpose', agent_id: 'dry-run-agent' }
  }
  if (eventName === 'TaskCreated' || eventName === 'TaskCompleted')
    return { task_kind: 'agent', task_id: 'dry-run-task' }
  if (eventName === 'PreCompact' || eventName === 'PostCompact')
    return { trigger: 'manual' }
  if (eventName === 'SessionStart') return { source: 'startup' }
  if (eventName === 'SessionEnd') return { reason: 'completed' }
  if (eventName === 'UserPromptSubmit') return { prompt: 'Review this prompt.' }
  if (eventName === 'StopFailure')
    return { error_kind: 'provider_error', error: 'dry-run' }
  if (eventName === 'Stop') return { reason: 'completed' }
  return matcherField ? { [matcherField]: '*' } : {}
}

export function defaultDryRunInput(
  event: HookEventMetadataPayload | null | undefined,
): string {
  return JSON.stringify(
    dryRunInput(String(event?.eventName || ''), event?.matcherField ?? null),
    null,
    2,
  )
}

export function auditQuery(filters: {
  eventName?: string
  outcome?: string
  sourceId?: string
  runId?: string
  cursor?: string | null
  limit?: number
}): Record<string, unknown> {
  const query: Record<string, unknown> = { limit: filters.limit ?? 50 }
  if (filters.eventName) query.eventName = filters.eventName
  if (filters.outcome) query.outcome = filters.outcome
  if (filters.sourceId) query.sourceId = filters.sourceId
  if (filters.runId) query.runId = filters.runId
  if (filters.cursor) query.cursor = filters.cursor
  return query
}

export function isStaleHooksError(error: unknown): boolean {
  return /stale hooks revision/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

export function cancellableRunIds(result: unknown): string[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return []
  const runs = (result as { results?: unknown }).results
  if (!Array.isArray(runs)) return []
  return runs.flatMap((run) => {
    if (!run || typeof run !== 'object' || Array.isArray(run)) return []
    const record = run as Record<string, unknown>
    return record.asyncRewakeEligible === true &&
      typeof record.hookRunId === 'string'
      ? [record.hookRunId]
      : []
  })
}
