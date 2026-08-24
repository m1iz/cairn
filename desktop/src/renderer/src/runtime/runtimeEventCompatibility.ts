import type { RuntimeEventProjection, WsEvent } from '../types'

interface HistoricalContinuationEvent extends RuntimeEventProjection {
  event: 'turn_continuation_evaluated'
  decision?: 'continue' | 'finalize' | 'pause'
  grantedIterations?: number
  summary?: string
  nextActions?: string[]
}

/**
 * Runtime compatibility belongs at the replay boundary, not in the current
 * Core event contract. Old continuation-budget events are normalized to one
 * generic historical activity before any current projection consumes them.
 */
export function normalizeRuntimeEvent(
  raw: RuntimeEventProjection | WsEvent,
): WsEvent {
  if (raw.event !== 'turn_continuation_evaluated') return raw as WsEvent
  const historical = raw as HistoricalContinuationEvent
  const decision =
    historical.decision === 'continue' || historical.decision === 'finalize'
      ? historical.decision
      : 'pause'
  const granted = Math.max(0, Number(historical.grantedIterations || 0))
  return {
    ...historical,
    event: 'historical_runtime_activity',
    label:
      decision === 'continue'
        ? `历史记录：评估后继续执行${granted ? ` · 追加 ${granted} 次迭代` : ''}`
        : decision === 'finalize'
          ? '历史记录：执行完成，正在整理交付'
          : '历史记录：执行已暂停',
    detail: String(historical.summary || '').trim(),
    tone:
      decision === 'continue'
        ? 'running'
        : decision === 'finalize'
          ? 'success'
          : 'error',
    running: decision !== 'pause',
    action: decision === 'pause' ? 'continue' : undefined,
    nextActions: Array.isArray(historical.nextActions)
      ? historical.nextActions.map(String)
      : [],
  } as unknown as WsEvent
}

export function normalizeRuntimeEvents(
  events: RuntimeEventProjection[],
): WsEvent[] {
  return events.map(normalizeRuntimeEvent)
}
