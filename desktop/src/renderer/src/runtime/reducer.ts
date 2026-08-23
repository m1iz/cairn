import type { GoalProjectionState, RuntimeEventEnvelope } from '../types'
import { isGoalRuntimeEvent, sortRuntimeEvents } from './events'
import { applyGoalEvent, createGoalProjectionState } from './handlers/goals'

export interface RuntimeReducerAction {
  event: RuntimeEventEnvelope
}

export function replayRuntimeEvents(
  events: RuntimeEventEnvelope[],
  dispatch: (action: RuntimeReducerAction) => void,
) {
  for (const event of sortRuntimeEvents(events)) dispatch({ event })
}

export function replayGoalRuntimeEvents(
  events: RuntimeEventEnvelope[],
  initial: GoalProjectionState = createGoalProjectionState(),
): GoalProjectionState {
  let projection = initial
  for (const event of sortRuntimeEvents(events)) {
    if (isGoalRuntimeEvent(event))
      projection = applyGoalEvent(projection, event)
  }
  return projection
}
