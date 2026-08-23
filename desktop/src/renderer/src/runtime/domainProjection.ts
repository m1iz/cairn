import type { WsEvent } from '../types'
import { isGoalRuntimeEvent } from './events'
import {
  applyGoalEvent,
  createGoalProjectionState,
  type GoalProjectionState,
} from './handlers/goals'
import { applyPlanEvent, type PlanProjection } from './handlers/plans'
import {
  createTaskProjectionState,
  isTaskRuntimeEvent,
  reduceTaskProjection,
  type TaskProjectionState,
} from './taskProjection'

export interface DomainProjectionState {
  plans: PlanProjection
  goals: GoalProjectionState
  tasks: TaskProjectionState
}

export interface DomainProjectionTransition {
  state: DomainProjectionState
  accepted: boolean
  domain: 'plan' | 'goal' | 'task' | null
}

const PLAN_EVENTS = new Set<string>([
  'plan_approved',
  'plan_entry_decision',
  'plan_runtime_update',
  'plan_step_update',
  'plan_verification_start',
  'plan_verification_done',
])

export function createDomainProjectionState(): DomainProjectionState {
  return {
    plans: { plans: [], entryDecisions: [] },
    goals: createGoalProjectionState(),
    tasks: createTaskProjectionState(),
  }
}

/** One pure reducer for domain events from live, replay, or bootstrap sources. */
export function reduceDomainProjection(
  state: DomainProjectionState,
  event: WsEvent,
): DomainProjectionTransition {
  if (PLAN_EVENTS.has(event.event)) {
    return {
      state: {
        ...state,
        plans: applyPlanEvent(state.plans, event as never),
      },
      accepted: true,
      domain: 'plan',
    }
  }

  if (isGoalRuntimeEvent(event)) {
    const goals = applyGoalEvent(state.goals, event)
    return {
      state: goals === state.goals ? state : { ...state, goals },
      accepted: goals !== state.goals,
      domain: 'goal',
    }
  }

  if (isTaskRuntimeEvent(event)) {
    const transition = reduceTaskProjection(state.tasks, {
      type: 'task_event_received',
      event,
    })
    return {
      state: transition.accepted
        ? { ...state, tasks: transition.state }
        : state,
      accepted: transition.accepted,
      domain: 'task',
    }
  }

  return { state, accepted: false, domain: null }
}
