import type { ToolObservation } from '../contracts/tool'

export type ToolRunPhase = 'queued' | 'executing' | ToolObservation['status']

export interface ToolLifecycleState {
  phase: ToolRunPhase
  observation: ToolObservation | null
  terminalCount: number
}

export type ToolLifecycleEvent =
  { type: 'started' } | { type: 'observed'; observation: ToolObservation }

export function initialToolLifecycle(): ToolLifecycleState {
  return { phase: 'queued', observation: null, terminalCount: 0 }
}

export function transitionToolLifecycle(
  state: ToolLifecycleState,
  event: ToolLifecycleEvent,
): ToolLifecycleState {
  if (event.type === 'started') {
    if (state.phase !== 'queued')
      throw new Error(`tool cannot start from ${state.phase}`)
    return { ...state, phase: 'executing' }
  }
  if (state.observation) return state
  if (state.phase !== 'queued' && state.phase !== 'executing')
    throw new Error(`tool cannot terminate from ${state.phase}`)
  return {
    phase: event.observation.status,
    observation: structuredClone(event.observation),
    terminalCount: 1,
  }
}
