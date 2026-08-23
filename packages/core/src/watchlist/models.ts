import { nowTs } from '../util/time'

export type WatchlistAction = 'skip' | 'run'

export class WatchlistDecision {
  action: WatchlistAction
  reason: string
  message: string
  checked_at: number
  model: string | null
  provider: string | null
  model_entry_id: string | null
  /** 历史记录读取兼容；新记录不再写入。 */
  model_role: string | null

  constructor(
    opts: {
      action?: WatchlistAction
      reason?: string
      message?: string
      checked_at?: number
      model?: string | null
      provider?: string | null
      model_entry_id?: string | null
      model_role?: string | null
    } = {},
  ) {
    this.action = opts.action ?? 'skip'
    this.reason = opts.reason ?? ''
    this.message = opts.message ?? ''
    this.checked_at = opts.checked_at ?? 0
    this.model = opts.model ?? null
    this.provider = opts.provider ?? null
    this.model_entry_id = opts.model_entry_id ?? null
    this.model_role = opts.model_role ?? null
  }

  static skip(reason: string): WatchlistDecision {
    return new WatchlistDecision({
      action: 'skip',
      reason,
      checked_at: nowTs(),
    })
  }

  static fromDict(raw: Record<string, unknown>): WatchlistDecision {
    const action =
      String(raw.action ?? 'skip').toLowerCase() === 'run' ? 'run' : 'skip'
    return new WatchlistDecision({
      action,
      reason: String(raw.reason ?? ''),
      message: String(raw.message ?? ''),
      checked_at: Number(raw.checked_at ?? raw.checkedAt ?? nowTs()),
      model: nullableString(raw.model),
      provider: nullableString(raw.provider),
      model_entry_id: nullableString(raw.model_entry_id ?? raw.modelEntryId),
      model_role: nullableString(raw.model_role ?? raw.modelRole),
    })
  }

  toDict(): Record<string, unknown> {
    return {
      action: this.action,
      reason: this.reason,
      message: this.message,
      checkedAt: this.checked_at,
      model: this.model,
      provider: this.provider,
      modelEntryId: this.model_entry_id,
      ...(this.model_role ? { modelRole: this.model_role } : {}),
    }
  }
}

export function decisionPrompt(opts: {
  content: string
  items: string[]
}): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You are a local watchlist decision filter. Decide if the agent should proactively run now. Return strict JSON only: {"action":"skip|run","reason":"...","message":"..."}. Choose skip unless there is a concrete, timely, user-relevant action. Never include hidden reasoning.',
    },
    {
      role: 'user',
      content: `Current watchlist markdown:\n${opts.content}\n\nActive items:\n${opts.items.map((item) => `- ${item}`).join('\n')}`,
    },
  ]
}

export function parseWatchlistDecision(text: string): WatchlistDecision {
  let raw = text.trim()
  const match = /\{[\s\S]*\}/.exec(raw)
  if (match) raw = match[0]
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return WatchlistDecision.skip('watchlist model returned non-JSON decision')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return WatchlistDecision.skip('watchlist model returned invalid decision')
  const decision = WatchlistDecision.fromDict(parsed as Record<string, unknown>)
  decision.reason = clean(decision.reason).slice(0, 500)
  decision.message = clean(decision.message).slice(0, 1200)
  if (decision.action === 'run' && !decision.message) {
    decision.action = 'skip'
    decision.reason =
      decision.reason || 'run decision had no actionable message'
  }
  return decision
}

function clean(value: string): string {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? '')
  return text || null
}
