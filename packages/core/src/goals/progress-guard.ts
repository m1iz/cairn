import { createHash } from 'node:crypto'
import { canonicalJson } from './events'

export interface GoalProgressSnapshot {
  readonly lastEventSeq: number
  readonly planUpdatedAt: string | null
  readonly activePlanStepId: string | null
  readonly activePlanStepStatus: string | null
  readonly evidenceIds: readonly string[]
  readonly observationCount: number
  readonly pendingInteractionId: string | null
}

export interface GoalProgressAssessment {
  readonly beforeSignature: string
  readonly afterSignature: string
  readonly progressed: boolean
  readonly consecutiveNoEvidenceCycles: number
  readonly shouldPause: boolean
}

export class GoalProgressGuard {
  signature(snapshot: GoalProgressSnapshot): string {
    return createHash('sha256')
      .update(
        canonicalJson({
          lastEventSeq: snapshot.lastEventSeq,
          planUpdatedAt: snapshot.planUpdatedAt,
          activePlanStepId: snapshot.activePlanStepId,
          activePlanStepStatus: snapshot.activePlanStepStatus,
          evidenceIds: [...new Set(snapshot.evidenceIds)].sort(),
          observationCount: snapshot.observationCount,
          pendingInteractionId: snapshot.pendingInteractionId,
        }),
      )
      .digest('hex')
  }

  assessCycle(input: {
    readonly before: GoalProgressSnapshot
    readonly after: GoalProgressSnapshot
    readonly previousConsecutiveNoEvidenceCycles: number
    readonly pauseAfterCycles?: number
    readonly explicitReplan?: boolean
    readonly failedEvidenceRecorded?: boolean
    readonly userDecisionRecorded?: boolean
  }): GoalProgressAssessment {
    const beforeSignature = this.signature(input.before)
    const afterSignature = this.signature(input.after)
    const progressed =
      beforeSignature !== afterSignature ||
      input.explicitReplan === true ||
      input.failedEvidenceRecorded === true ||
      input.userDecisionRecorded === true
    const consecutiveNoEvidenceCycles = progressed
      ? 0
      : input.previousConsecutiveNoEvidenceCycles + 1
    const pauseAfterCycles = input.pauseAfterCycles ?? 3
    return Object.freeze({
      beforeSignature,
      afterSignature,
      progressed,
      consecutiveNoEvidenceCycles,
      shouldPause:
        pauseAfterCycles > 0 && consecutiveNoEvidenceCycles >= pauseAfterCycles,
    })
  }
}
