import type { JsonObject } from './events'
import type { GoalGateMutationSnapshot } from './mutation-ledger'
import type { GoalRecord } from './models'

export type GoalPostCommitFailureCode =
  | 'plan_token_revoke_failed'
  | 'active_run_clear_failed'
  | 'pending_interaction_clear_failed'
  | 'runtime_event_emit_failed'
  | 'diagnostic_persist_failed'

export interface GoalTerminalCommitInput {
  readonly record: GoalRecord
  readonly createdAt?: string
  readonly data?: Readonly<JsonObject>
  readonly expectedLastEventSeq: number
  readonly mutationPrecondition: GoalGateMutationSnapshot
  readonly validatePrecondition: () => void | Promise<void>
}
