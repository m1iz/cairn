/** Compatibility facade for the v2 turn machine. */
import { TurnMachine, turnPhaseRuntimeEvent } from '../v2/harness/turn-machine'

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
  private readonly machine: TurnMachine

  constructor(opts?: { turnId?: string | null }) {
    this.machine = new TurnMachine({
      turnId: opts?.turnId ?? null,
      initialPhase: TurnPhase.STARTED,
    })
  }

  get turnId(): string | null {
    return this.machine.snapshot().turnId
  }

  set turnId(turnId: string | null) {
    if (turnId !== this.turnId)
      throw new Error('turnId is immutable after TurnState construction')
  }

  get iteration(): number {
    return this.machine.snapshot().iteration
  }

  get sequence(): number {
    return this.machine.snapshot().sequence
  }

  get phase(): TurnPhase {
    return this.machine.snapshot().phase as TurnPhase
  }

  startIteration(): number {
    return this.machine.startIteration()
  }

  transition(
    phase: TurnPhase | string,
    opts?: { detail?: Record<string, unknown> | null },
  ): TurnPhaseEvent {
    const event = this.machine.transition(String(phase), opts?.detail ?? {})
    return {
      ...event,
      detail: { ...event.detail },
      toRuntimeEvent: () => turnPhaseRuntimeEvent(event),
    }
  }
}
