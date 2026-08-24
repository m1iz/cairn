import type { GoalProjectionState, RuntimeEventProjection } from '../types'
import { isGoalRuntimeEvent, sortRuntimeEvents } from './events'
import { applyGoalEvent, createGoalProjectionState } from './handlers/goals'

export interface RuntimeReducerAction {
  event: RuntimeEventProjection
}

export function replayRuntimeEvents(
  events: RuntimeEventProjection[],
  dispatch: (action: RuntimeReducerAction) => void,
) {
  for (const event of sortRuntimeEvents(events)) dispatch({ event })
}

export function replayGoalRuntimeEvents(
  events: RuntimeEventProjection[],
  initial: GoalProjectionState = createGoalProjectionState(),
): GoalProjectionState {
  let projection = initial
  for (const event of sortRuntimeEvents(events)) {
    if (isGoalRuntimeEvent(event))
      projection = applyGoalEvent(projection, event)
  }
  return projection
}
