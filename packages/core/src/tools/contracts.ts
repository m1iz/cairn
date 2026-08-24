export interface ToolIntent {
  id: string
  name: string
  arguments: Readonly<Record<string, unknown>>
  concurrencySafe: boolean
}

export type ToolAuthorizationDecision =
  | { outcome: 'allowed'; rule: string }
  | { outcome: 'approval_required'; requestId: string; rule: string }
  | { outcome: 'denied'; reason: string; rule: string }

declare const authorizedToolCall: unique symbol

export interface AuthorizedToolCall extends ToolIntent {
  readonly [authorizedToolCall]: true
  authorizationRule: string
}

export type ToolObservation =
  | {
      status: 'completed'
      summary: string
      output: string
      metadata: Readonly<Record<string, unknown>>
    }
  | {
      status: 'failed'
      message: string
      metadata: Readonly<Record<string, unknown>>
    }
  | { status: 'cancelled'; reason: string }

export function authorizeToolIntent(
  intent: ToolIntent,
  decision: ToolAuthorizationDecision,
): AuthorizedToolCall {
  if (decision.outcome !== 'allowed')
    throw new Error(`tool intent is not authorized: ${decision.outcome}`)
  return {
    ...intent,
    arguments: structuredClone(intent.arguments),
    authorizationRule: decision.rule,
  } as AuthorizedToolCall
}
