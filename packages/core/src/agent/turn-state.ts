export enum TurnPhase {
  STARTED = 'started',
  CHECKPOINT = 'checkpoint',
  MODEL_REQUEST = 'model_request',
  MODEL_RESPONSE = 'model_response',
  TOOL_BATCH_START = 'tool_batch_start',
  TOOL_BATCH_DONE = 'tool_batch_done',
  EMPTY_RETRY = 'empty_retry',
  LENGTH_RETRY = 'length_retry',
  TODO_FOLLOWUP = 'todo_followup',
  PLAN_FOLLOWUP = 'plan_followup',
  COMPACT_CHECK = 'compact_check',
  PAUSED = 'paused',
  MAX_TURNS = 'max_turns',
  COMPLETED = 'completed',
}

export interface TurnPhaseEvent {
  phase: string
  sequence: number
  iteration: number
  turnId: string | null
  detail: Record<string, unknown>
  toRuntimeEvent(): Record<string, unknown>
}

export class TurnState {
  private readonly _turnId: string | null
  private _iteration = 0
  private _sequence = 0
  private _phase: TurnPhase | string = TurnPhase.STARTED

  constructor(opts?: { turnId?: string | null }) {
    this._turnId = opts?.turnId ?? null
  }

  get turnId(): string | null {
    return this._turnId
  }

  set turnId(turnId: string | null) {
    if (turnId !== this.turnId)
      throw new Error('turnId is immutable after TurnState construction')
  }

  get iteration(): number {
    return this._iteration
  }

  get sequence(): number {
    return this._sequence
  }

  get phase(): TurnPhase {
    return this._phase as TurnPhase
  }

  startIteration(): number {
    this._iteration += 1
    return this._iteration
  }

  transition(
    phase: TurnPhase | string,
    opts?: { detail?: Record<string, unknown> | null },
  ): TurnPhaseEvent {
    this._phase = String(phase)
    this._sequence += 1
    const detail = structuredClone(opts?.detail ?? {})
    const event = {
      phase: this._phase,
      sequence: this._sequence,
      iteration: this._iteration,
      turnId: this._turnId,
      detail,
    }
    return {
      ...event,
      detail: structuredClone(detail),
      toRuntimeEvent: () => ({
        event: 'turn_phase',
        phase: event.phase,
        sequence: event.sequence,
        iteration: event.iteration,
        ...(event.turnId ? { turn_id: event.turnId } : {}),
        ...(Object.keys(event.detail).length
          ? { detail: structuredClone(event.detail) }
          : {}),
      }),
    }
  }
}
