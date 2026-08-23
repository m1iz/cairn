export interface TurnPhaseSnapshot {
  phase: string
  sequence: number
  iteration: number
  turnId: string | null
}

export interface TurnPhaseEvent extends TurnPhaseSnapshot {
  detail: Readonly<Record<string, unknown>>
}
