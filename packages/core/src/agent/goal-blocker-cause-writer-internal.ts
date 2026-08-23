import {
  authorizeGoalBlockerCauseWriter,
  GoalBlockerCauseLedger,
  persistAuthorizedGoalBlockerCause,
} from '../goals/blocker-cause-ledger'
import type { GoalBlockerCause } from '../goals/blocker-facts'
import type { GoalRecord } from '../goals/models'
import { ControlManager } from '../control/manager'

/** Internal capability for future Control/permission/external adapters. */
export class CoreGoalBlockerCauseWriter {
  private constructor(private readonly ledger: GoalBlockerCauseLedger) {}

  static create(ledger: GoalBlockerCauseLedger): CoreGoalBlockerCauseWriter {
    if (!(ledger instanceof GoalBlockerCauseLedger))
      throw new Error('Goal blocker cause writer requires the Core ledger.')
    const writer = new CoreGoalBlockerCauseWriter(ledger)
    authorizeGoalBlockerCauseWriter(writer, ledger)
    return writer
  }

  record(goal: GoalRecord, cause: GoalBlockerCause, receiptId: string) {
    return persistAuthorizedGoalBlockerCause(
      this,
      this.ledger,
      goal,
      cause,
      receiptId,
    )
  }
}

/** Bridges only an exact persisted dedicated Control denial into cause authority. */
export class CoreGoalBlockerControlAdapter {
  private constructor(
    private readonly writer: CoreGoalBlockerCauseWriter,
    private readonly control: ControlManager,
  ) {}

  static create(
    writer: CoreGoalBlockerCauseWriter,
    control: ControlManager,
  ): CoreGoalBlockerControlAdapter {
    if (!(writer instanceof CoreGoalBlockerCauseWriter))
      throw new Error('Goal blocker Control adapter requires the Core writer.')
    if (!(control instanceof ControlManager))
      throw new Error('Goal blocker Control adapter requires ControlManager.')
    return new CoreGoalBlockerControlAdapter(writer, control)
  }

  recordPermissionDenial(goal: GoalRecord, interactionId: string) {
    const resolution = this.control.goalBlocker.resolvePermissionDenial(
      goal,
      interactionId,
      { allowHistoricalReceipt: true },
    )
    if (!resolution)
      throw new Error(
        'Goal blocker requires an exact persisted permission denial.',
      )
    return this.writer.record(goal, resolution.cause, resolution.receiptId)
  }
}
