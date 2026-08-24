import type { GoalRecord } from './models'
import type { GoalTerminalCommitInput } from './terminal-contracts'

type GoalTerminalType = 'goal_completed' | 'goal_blocked'
type GoalTerminalCommitter = (
  goalId: string,
  type: GoalTerminalType,
  input: GoalTerminalCommitInput,
) => Promise<GoalRecord>

const STORE_COMMITTERS = new WeakMap<object, GoalTerminalCommitter>()
interface GoalTerminalAuthority {
  readonly store: object
  readonly options: object
}

const AUTHORIZED_GATES = new WeakMap<object, GoalTerminalAuthority>()

/** Internal GoalStore registration; this module is not re-exported. */
export function registerGoalTerminalCommitter(
  store: object,
  committer: GoalTerminalCommitter,
): void {
  if (STORE_COMMITTERS.has(store))
    throw new Error('Goal terminal committer is already registered.')
  STORE_COMMITTERS.set(store, committer)
}

/** Internal composition-root grant; this module is not re-exported. */
export function authorizeGoalCompletionGate<Options extends object>(
  gate: object,
  store: object,
  options: Options,
): void {
  if (!STORE_COMMITTERS.has(store))
    throw new Error('GoalStore terminal committer is unavailable.')
  if (AUTHORIZED_GATES.has(gate))
    throw new Error('Goal completion Gate is already authorized.')
  AUTHORIZED_GATES.set(gate, Object.freeze({ store, options }))
}

export function trustedGoalCompletionGateOptions<Options extends object>(
  gate: object,
): Options {
  const authority = AUTHORIZED_GATES.get(gate)
  if (!authority)
    throw new Error('Goal completion Gate lacks terminal authority.')
  return authority.options as Options
}

/** Authorized Gates ignore mutable instance fields; plain evaluators use their input. */
export function goalCompletionGateOptions<Options extends object>(
  gate: object,
  fallback: Options,
): Options {
  return (
    (AUTHORIZED_GATES.get(gate)?.options as Options | undefined) ?? fallback
  )
}

export function commitAuthorizedGoalTerminal(
  gate: object,
  goalId: string,
  type: GoalTerminalType,
  input: GoalTerminalCommitInput,
): Promise<GoalRecord> {
  const authority = AUTHORIZED_GATES.get(gate)
  if (!authority)
    throw new Error('Goal completion Gate lacks terminal authority.')
  const commit = STORE_COMMITTERS.get(authority.store)
  if (!commit) throw new Error('GoalStore terminal committer is unavailable.')
  return commit(goalId, type, input)
}
