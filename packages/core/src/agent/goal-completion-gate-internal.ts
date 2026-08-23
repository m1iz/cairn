import { GoalBlockerFactStore } from '../goals/blocker-facts'
import {
  GoalCompletionGate,
  type GoalCompletionGateOptions,
  type GoalCompletionCleanup,
} from '../goals/completion-gate'
import { GoalEvidenceLedger } from '../goals/evidence'
import { GoalGateFactStore } from '../goals/gate-facts'
import { authorizeGoalCompletionGate } from '../goals/goal-terminal-internal'
import { GoalPlanBridge } from '../goals/plan-bridge'
import { GoalReviewerLedger } from '../goals/reviewer'
import { GoalStore } from '../goals/store'

/**
 * The sole production composition root for an authority-bearing completion
 * Gate. It is intentionally absent from goals/index.ts and package exports.
 */
export function createAuthorizedGoalCompletionGate(
  options: GoalCompletionGateOptions,
): GoalCompletionGate {
  if (process.env.NODE_ENV !== 'test') assertCoreDependencies(options)
  const trustedOptions = trustedOptionsSnapshot(options)
  const gate = new GoalCompletionGate(trustedOptions)
  authorizeGoalCompletionGate(gate, options.goalStore, trustedOptions)
  return gate
}

function trustedOptionsSnapshot(
  options: GoalCompletionGateOptions,
): GoalCompletionGateOptions {
  const goalStore = Object.freeze({
    stateRoot: options.goalStore.stateRoot,
    goalsRoot: options.goalStore.goalsRoot,
    inspect: options.goalStore.inspect.bind(options.goalStore),
    get: options.goalStore.get.bind(options.goalStore),
    list: options.goalStore.list.bind(options.goalStore),
    readEventsReadonly: options.goalStore.readEventsReadonly.bind(
      options.goalStore,
    ),
  }) as unknown as GoalStore
  const cleanup: GoalCompletionCleanup | undefined = options.cleanup
    ? Object.freeze({
        revokePlanTokens: options.cleanup.revokePlanTokens?.bind(
          options.cleanup,
        ),
        clearActiveRun: options.cleanup.clearActiveRun?.bind(options.cleanup),
        clearPendingInteraction: options.cleanup.clearPendingInteraction?.bind(
          options.cleanup,
        ),
      })
    : undefined
  return Object.freeze({
    goalStore,
    planBridge: Object.freeze({
      planCompletionReceipt: options.planBridge.planCompletionReceipt.bind(
        options.planBridge,
      ),
    }),
    evidenceLedger: Object.freeze({
      validatedEvidenceById: options.evidenceLedger.validatedEvidenceById.bind(
        options.evidenceLedger,
      ),
    }),
    reviewerLedger: Object.freeze({
      latestReviewerDecision:
        options.reviewerLedger.latestReviewerDecision.bind(
          options.reviewerLedger,
        ),
    }),
    factStore: Object.freeze({
      inspectBundle: options.factStore.inspectBundle.bind(options.factStore),
    }) as GoalGateFactStore,
    blockerFactStore: Object.freeze({
      inspect: options.blockerFactStore.inspect.bind(options.blockerFactStore),
    }) as GoalBlockerFactStore,
    inspectLiveFacts: options.inspectLiveFacts?.bind(undefined),
    cleanup,
    emitRuntimeEvent: options.emitRuntimeEvent?.bind(undefined),
    recordDiagnostic: options.recordDiagnostic?.bind(undefined),
    beforeDiagnosticAppend: options.beforeDiagnosticAppend?.bind(undefined),
    beforeCleanupAck: options.beforeCleanupAck?.bind(undefined),
    onCleanupClaimTrace: options.onCleanupClaimTrace?.bind(undefined),
    beforeCompletionWrite: options.beforeCompletionWrite?.bind(undefined),
    beforeCompletionRecheck: options.beforeCompletionRecheck?.bind(undefined),
    beforeBlockerRecheck: options.beforeBlockerRecheck?.bind(undefined),
    beforeBlockerTerminalValidation:
      options.beforeBlockerTerminalValidation?.bind(undefined),
    now: options.now?.bind(undefined),
  })
}

function assertCoreDependencies(options: GoalCompletionGateOptions): void {
  if (
    !(options.goalStore instanceof GoalStore) ||
    !(options.planBridge instanceof GoalPlanBridge) ||
    !(options.evidenceLedger instanceof GoalEvidenceLedger) ||
    !(options.reviewerLedger instanceof GoalReviewerLedger) ||
    !(options.factStore instanceof GoalGateFactStore) ||
    !(options.blockerFactStore instanceof GoalBlockerFactStore)
  )
    throw new Error(
      'Goal completion Gate requires concrete Core-owned dependencies.',
    )
}
