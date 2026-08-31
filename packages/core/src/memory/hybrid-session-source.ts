import type { HybridMemoryDocument } from './hybrid-index'

type HistoryRow = Record<string, unknown>

export interface HybridSessionSourceInput {
  sessionId: string
  mode: 'chat' | 'build'
  projectId?: string | null
  historyPath: string
  history: readonly HistoryRow[]
  updatedAt: number
}

/**
 * Projects the active conversation branch into a derived retrieval document.
 * The conversation/message graph remains authoritative; this projection is
 * rebuilt on every turn and never writes back into session history.
 */
export function hybridSessionDocuments(
  input: HybridSessionSourceInput,
): HybridMemoryDocument[] {
  const sessionId = clean(input.sessionId)
  const historyPath = clean(input.historyPath)
  if (!sessionId || !historyPath) return []

  const documents: HybridMemoryDocument[] = []
  let visibleIndex = 0
  for (const row of input.history) {
    if (row.ui_hidden === true || row.hidden === true) continue
    if (row.type === 'model_call' || row.type === 'compact_event') continue
    const role = clean(row.role).toLowerCase()
    if (role !== 'user' && role !== 'assistant') continue
    const content = historyText(row, role)
    if (!content) continue
    visibleIndex += 1
    const turnId = clean(row.turn_id)
    const label = role === 'user' ? 'User' : 'Assistant'
    const seq = positiveInteger(row.seq)
    const messageKey = seq ? `seq:${seq}` : `message:${visibleIndex}`
    const projectId =
      input.mode === 'build' ? clean(input.projectId) || null : null
    documents.push({
      id: `session:${sessionId}:${messageKey}`,
      content: `## Session message · ${label}${turnId ? ` · ${turnId}` : ''}\n\n${content}`,
      source: 'session',
      path: `${historyPath}#${messageKey}`,
      createdAt: timestamp(row.ts, input.updatedAt),
      projectId,
      sessionId,
    })
  }
  return documents
}

function historyText(row: HistoryRow, role: string): string {
  const display = role === 'user' ? clean(row.displayContent) : ''
  if (display) return display
  const content = row.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return ''
      const value = part as Record<string, unknown>
      const type = clean(value.type)
      if (
        type &&
        type !== 'text' &&
        type !== 'input_text' &&
        type !== 'output_text'
      )
        return ''
      return clean(value.text)
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInteger(value: unknown): number | null {
  const number = Math.trunc(Number(value) || 0)
  return number > 0 ? number : null
}

function timestamp(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed)
    ? Math.max(0, parsed)
    : Math.max(0, Number(fallback) || 0)
}
