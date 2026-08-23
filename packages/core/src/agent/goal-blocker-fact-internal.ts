import { GoalBlockerCauseLedger } from '../goals/blocker-cause-ledger'
import {
  authorizeGoalBlockerFactIssuer,
  persistAuthorizedGoalBlockerFact,
  type GoalBlockerFact,
  GoalBlockerFactStore,
  type GoalTypedBlockerCode,
} from '../goals/blocker-facts'
import type { GoalRecord } from '../goals/models'

/**
 * Internal issuer backed only by the capability-protected cause ledger.
 * Callers provide a reason, never an "issuedBy: core" receipt or resolver.
 */
export class CoreGoalBlockerFactIssuer {
  private constructor(
    private readonly store: GoalBlockerFactStore,
    private readonly causeLedger: GoalBlockerCauseLedger,
    private readonly now: () => string,
  ) {}

  static create(options: {
    readonly store: GoalBlockerFactStore
    readonly causeLedger: GoalBlockerCauseLedger
    readonly now?: () => string
  }): CoreGoalBlockerFactIssuer {
    if (
      !(options.store instanceof GoalBlockerFactStore) ||
      !(options.causeLedger instanceof GoalBlockerCauseLedger)
    )
      throw new Error('Goal blocker issuer requires concrete Core ledgers.')
    const issuer = new CoreGoalBlockerFactIssuer(
      options.store,
      options.causeLedger,
      options.now ?? (() => new Date().toISOString()),
    )
    authorizeGoalBlockerFactIssuer(issuer, options.store)
    return issuer
  }

  issue(
    goal: GoalRecord,
    input: { readonly code: GoalTypedBlockerCode; readonly reason: string },
  ): GoalBlockerFact {
    return persistAuthorizedGoalBlockerFact(this, this.store, goal, {
      ...input,
      cause: this.causeLedger.inspect(goal),
      createdAt: this.now(),
    })
  }
}
