import type { TurnPhaseEvent, TurnPhaseSnapshot } from '../contracts/turn'

export class TurnMachine {
  private state: TurnPhaseSnapshot

  constructor(opts: { turnId?: string | null; initialPhase?: string } = {}) {
    this.state = {
      turnId: opts.turnId ?? null,
      phase: opts.initialPhase ?? 'started',
      sequence: 0,
      iteration: 0,
    }
  }

  snapshot(): TurnPhaseSnapshot {
    return { ...this.state }
  }

  startIteration(): number {
    this.state = { ...this.state, iteration: this.state.iteration + 1 }
    return this.state.iteration
  }

  transition(
    phase: string,
    detail: Readonly<Record<string, unknown>> = {},
  ): TurnPhaseEvent {
    this.state = {
      ...this.state,
      phase,
      sequence: this.state.sequence + 1,
    }
    return { ...this.state, detail: structuredClone(detail) }
  }
}

export function turnPhaseRuntimeEvent(
  phase: TurnPhaseEvent,
): Record<string, unknown> {
  return {
    event: 'turn_phase',
    phase: phase.phase,
    sequence: phase.sequence,
    iteration: phase.iteration,
    ...(phase.turnId ? { turn_id: phase.turnId } : {}),
    ...(Object.keys(phase.detail).length
      ? { detail: structuredClone(phase.detail) }
      : {}),
  }
}
