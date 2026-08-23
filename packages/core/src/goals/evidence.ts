import { createHash } from 'node:crypto'
import { CairnError } from '../errors'
import type {
  ToolArtifact,
  ToolEvidencePolicy,
  ToolResultObj,
} from '../tools/base'
import { newId } from '../util/ids'
import { redactSensitiveOutput } from '../util/redaction'
import { canonicalJson } from './events'
import type { GoalAcceptanceCriterion, GoalRecord } from './models'
import { GoalStore, GoalStoreError } from './store'
import { assertGoalTransition } from './validation'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SUMMARY_MAX_CHARS = 500

interface ManagedArtifactDescriptor {
  readonly ref: string
  readonly kind: string
  readonly bytes: number
  readonly mediaKind: string
  readonly mime: string
}

export interface GoalObservation {
  readonly id: string
  readonly goalId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly taskId?: string
  readonly agentId?: string
  readonly toolInput: GoalToolInputDescriptor
  readonly evidencePolicy: ToolEvidencePolicy
  readonly eligible: boolean
  readonly eligibilityReason: string
  readonly isError: boolean
  readonly outputSha256: string
  readonly displaySummary: string
  readonly artifactRefs: readonly string[]
  readonly runtimeEventSeq: number | null
  readonly createdAt: string
  readonly integritySha256: string
}

export interface GoalToolInputDescriptor {
  readonly toolName: string
  readonly argumentsSha256: string
  readonly inputSha256: string
}

export interface GoalEvidence {
  readonly id: string
  readonly goalId: string
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail'
  readonly check: string
  readonly summary: string
  readonly sourceObservationIds: readonly string[]
  readonly sourceReceiptIds: readonly string[]
  readonly recorder: 'agent' | 'reviewer' | 'user' | 'system'
  readonly independent: boolean
  readonly createdAt: string
}

interface GoalEvidenceReceiptBase {
  readonly id: string
  readonly goalId: string
  readonly verdict: 'pass' | 'fail'
  readonly summary: string
  readonly outputSha256: string | null
  readonly createdAt: string
}

export interface GoalUserManualSource {
  readonly interactionId: string
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail'
}

export interface GoalUserManualActionReceipt {
  readonly schemaVersion: 'cairn.goal.user-manual-action.v1'
  readonly issuedBy: 'core'
  readonly action: 'record_goal_manual_verification'
  readonly interactionId: string
  readonly goalId: string
  readonly goalEventSeq: number
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail'
  readonly source: 'user'
  readonly question: Readonly<Record<string, unknown>>
  readonly coreSignature: string
}

export interface GoalIndependentReviewerSource {
  readonly reviewerReceiptId?: string
  readonly dispatchReceiptId?: string
  readonly dispatchOrdinal?: number
  readonly planId?: string
  readonly planEventSeq?: number
  readonly taskId: string
  readonly agentId?: string
  readonly transcriptRef: string
  readonly transcriptSha256?: string
  readonly riskFactVersion?: string | null
  readonly riskSignalsSha256?: string
  readonly commandObservationsSha256?: string
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail'
}

export interface GoalPlanVerificationSource {
  readonly planId: string
  readonly stepId: string
  readonly requirementId: string
  readonly toolCallId: string
  readonly sourceObservationId: string
  readonly approvedInputHash: string
}

export type GoalEvidenceReceipt =
  | (GoalEvidenceReceiptBase & {
      readonly kind: 'user_manual'
      readonly source: GoalUserManualSource
      readonly actionReceipt?: GoalUserManualActionReceipt
    })
  | (GoalEvidenceReceiptBase & {
      readonly kind: 'independent_reviewer'
      readonly source: GoalIndependentReviewerSource
    })
  | (GoalEvidenceReceiptBase & {
      readonly kind: 'plan_verification'
      readonly verdict: 'pass'
      readonly source: GoalPlanVerificationSource
      readonly outputSha256: string
    })

type GoalEvidenceReceiptDraft = GoalEvidenceReceipt extends infer Receipt
  ? Receipt extends GoalEvidenceReceipt
    ? Omit<Receipt, 'id' | 'goalId' | 'createdAt'>
    : never
  : never

export interface GoalUserManualFact extends GoalUserManualSource {
  readonly goalId: string
  readonly summary: string
  readonly actionReceipt?: GoalUserManualActionReceipt
}

export interface GoalIndependentReviewerFact extends GoalIndependentReviewerSource {
  readonly goalId: string
  readonly summary: string
}

export interface GoalPlanVerificationFact extends GoalPlanVerificationSource {
  readonly goalId: string
  readonly passed: true
  readonly summary: string
}

export interface GoalEvidenceFactResolvers {
  readonly resolveUserManual?: (
    goalId: string,
    source: GoalUserManualSource,
  ) => Promise<GoalUserManualFact | null> | GoalUserManualFact | null
  readonly resolveIndependentReviewer?: (
    goalId: string,
    source: GoalIndependentReviewerSource,
  ) =>
    | Promise<GoalIndependentReviewerFact | null>
    | GoalIndependentReviewerFact
    | null
  readonly resolvePlanVerification?: (
    goalId: string,
    source: GoalPlanVerificationSource,
  ) =>
    Promise<GoalPlanVerificationFact | null> | GoalPlanVerificationFact | null
}

export interface RecordGoalEvidenceInput {
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail'
  readonly check: string
  readonly summary: string
  readonly sourceObservationIds: readonly string[]
  readonly sourceReceiptIds: readonly string[]
}

export interface RecordToolResultInput {
  readonly expectedGoalId?: string | null
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly taskId?: string | null
  readonly agentId?: string | null
  readonly arguments?: Readonly<Record<string, unknown>>
  readonly evidencePolicy: ToolEvidencePolicy
  readonly executed: boolean
  readonly result: ToolResultObj
  readonly runtimeEventSeq?: number | null
  readonly artifactRefs?: readonly string[]
}

export class GoalEvidenceError extends CairnError {
  constructor(code: string, message: string) {
    super(message, code)
  }
}

export class GoalObservationRecorder {
  private readonly now: () => string
  private readonly idFactory: () => string
  private readonly isTrustedTaskTranscriptRef: (ref: string) => boolean
  private readonly mutex = new AsyncKeyedMutex()

  constructor(
    private readonly store: GoalStore,
    options: {
      readonly now?: () => string
      readonly idFactory?: () => string
      readonly isTrustedTaskTranscriptRef?: (ref: string) => boolean
    } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? (() => newId('obs_'))
    this.isTrustedTaskTranscriptRef =
      options.isTrustedTaskTranscriptRef ?? (() => false)
  }

  async captureExpectedGoalId(sessionIdValue: string): Promise<string | null> {
    const sessionId = requiredText(sessionIdValue, 'sessionId')
    const active = await this.store.findActiveBySession(sessionId)
    return active?.status === 'active' ? active.id : null
  }

  async recordToolResult(
    input: RecordToolResultInput,
  ): Promise<GoalObservation | null> {
    if (!input.executed) return null
    const sessionId = requiredText(input.sessionId, 'sessionId')
    const expectedGoalId =
      input.expectedGoalId === undefined
        ? await this.captureExpectedGoalId(sessionId)
        : input.expectedGoalId
    if (expectedGoalId === null) return null
    const goalId = requiredId(expectedGoalId, 'expected Goal ID')
    return this.mutex.run(goalId, async () => {
      const artifactRefs = normalizeArtifactRefs([
        ...artifactDescriptors(input.result).map((item) => item.ref),
        ...(input.artifactRefs ?? []).filter(
          (ref): ref is string =>
            isTaskTranscriptRef(ref) && this.isTrustedTaskTranscriptRef(ref),
        ),
      ])
      const base: Omit<GoalObservation, 'integritySha256'> = {
        id: requiredId(this.idFactory(), 'observation ID'),
        goalId,
        turnId: requiredId(input.turnId, 'turn ID'),
        toolCallId: requiredId(input.toolCallId, 'tool call ID'),
        toolName: requiredText(input.toolName, 'tool name'),
        ...reviewerTaskBinding(input.taskId, input.agentId),
        toolInput: computeGoalToolInputSha256(
          requiredText(input.toolName, 'tool name'),
          input.arguments ?? {},
        ),
        evidencePolicy: input.evidencePolicy,
        eligible: input.evidencePolicy === 'eligible',
        eligibilityReason: eligibilityReason(input.evidencePolicy),
        isError: input.result.isError,
        outputSha256: computeGoalObservationOutputSha256(input.result),
        displaySummary: boundedSummary(
          input.result.displaySummary || input.result.modelContent,
        ),
        artifactRefs,
        runtimeEventSeq: normalizeRuntimeEventSeq(input.runtimeEventSeq),
        createdAt: normalizeTimestamp(this.now()),
      }
      const observation: GoalObservation = {
        ...base,
        integritySha256: computeObservationIntegrity(base),
      }
      const appended = await this.store.appendObservationIfActive(
        goalId,
        sessionId,
        observation,
      )
      return appended ? observation : null
    })
  }
}

export class GoalEvidenceLedger {
  private readonly now: () => string
  private readonly evidenceIdFactory: () => string
  private readonly receiptIdFactory: () => string
  private readonly factResolvers: GoalEvidenceFactResolvers
  private readonly beforeAppendAttempt:
    | ((context: {
        readonly goalId: string
        readonly evidence: GoalEvidence
        readonly attempt: number
        readonly snapshotLastEventSeq: number
      }) => Promise<void> | void)
    | null
  private readonly beforeReceiptAppendAttempt:
    | ((context: {
        readonly goalId: string
        readonly receipt: GoalEvidenceReceipt
        readonly attempt: number
        readonly snapshotLastEventSeq: number
      }) => Promise<void> | void)
    | null
  private readonly mutex = new AsyncKeyedMutex()

  constructor(
    private readonly store: GoalStore,
    options: {
      readonly now?: () => string
      readonly evidenceIdFactory?: () => string
      readonly receiptIdFactory?: () => string
      readonly factResolvers?: GoalEvidenceFactResolvers
      readonly beforeAppendAttempt?: (context: {
        readonly goalId: string
        readonly evidence: GoalEvidence
        readonly attempt: number
        readonly snapshotLastEventSeq: number
      }) => Promise<void> | void
      readonly beforeReceiptAppendAttempt?: (context: {
        readonly goalId: string
        readonly receipt: GoalEvidenceReceipt
        readonly attempt: number
        readonly snapshotLastEventSeq: number
      }) => Promise<void> | void
    } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.evidenceIdFactory =
      options.evidenceIdFactory ?? (() => newId('evidence_'))
    this.receiptIdFactory =
      options.receiptIdFactory ?? (() => newId('receipt_'))
    this.factResolvers = options.factResolvers ?? {}
    this.beforeAppendAttempt = options.beforeAppendAttempt ?? null
    this.beforeReceiptAppendAttempt = options.beforeReceiptAppendAttempt ?? null
  }

  async record(
    goalId: string,
    input: RecordGoalEvidenceInput,
    options: {
      readonly recorder?: GoalEvidence['recorder']
      readonly independent?: boolean
    } = {},
  ): Promise<GoalEvidence> {
    return this.mutex.run(goalId, async () => {
      const goal = await this.requireActiveGoal(goalId)
      const criterion = goal.contract.acceptanceCriteria.find(
        (item) => item.id === input.criterionId,
      )
      if (!criterion)
        throw evidenceError(
          'goal_evidence_criterion_unknown',
          'Goal acceptance criterion does not exist.',
        )
      const observationIds = uniqueSortedIds(
        input.sourceObservationIds,
        'observation',
      )
      const receiptIds = uniqueSortedIds(input.sourceReceiptIds, 'receipt')
      if (
        input.verdict === 'pass' &&
        !observationIds.length &&
        !receiptIds.length
      )
        throw evidenceError(
          'goal_evidence_pass_source_required',
          'PASS evidence requires at least one trusted source.',
        )
      if (
        input.verdict === 'fail' &&
        !observationIds.length &&
        !receiptIds.length
      )
        throw evidenceError(
          'goal_evidence_fail_source_required',
          'FAIL evidence requires at least one trusted source.',
        )

      const observations = await this.resolveObservations(
        goal.id,
        observationIds,
      )
      const receipts = await this.resolveReceipts(goal.id, receiptIds)
      assertEligibleObservations(observations)
      assertVerificationCompatibility(
        criterion,
        input.verdict,
        observations,
        receipts,
      )
      const createdAt = normalizeTimestamp(this.now())
      const evidence: GoalEvidence = {
        id: requiredId(this.evidenceIdFactory(), 'evidence ID'),
        goalId: goal.id,
        criterionId: criterion.id,
        verdict: input.verdict,
        check: boundedRequiredText(input.check, 'check', 1_000),
        summary: boundedSummary(input.summary),
        sourceObservationIds: observationIds,
        sourceReceiptIds: receiptIds,
        recorder: options.recorder ?? 'agent',
        independent:
          options.independent === true ||
          receipts.some((receipt) => receipt.kind === 'independent_reviewer'),
        createdAt,
      }
      await this.commitEvidenceWithRetry(evidence, goal.lastEventSeq)
      return evidence
    })
  }

  async issueUserManualReceipt(
    goalId: string,
    input: GoalUserManualSource,
  ): Promise<GoalEvidenceReceipt> {
    const source = parseUserManualSource(input)
    return await this.issueReceipt(goalId, async () => {
      const fact = await this.resolveUserManualFact(goalId, source)
      return {
        kind: 'user_manual',
        verdict: fact.verdict,
        source,
        ...(fact.actionReceipt ? { actionReceipt: fact.actionReceipt } : {}),
        summary: fact.summary,
        outputSha256: null,
      }
    })
  }

  async issueIndependentReviewerReceipt(
    goalId: string,
    input: GoalIndependentReviewerSource,
  ): Promise<GoalEvidenceReceipt> {
    const source = parseIndependentReviewerSource(input)
    return await this.issueReceipt(goalId, async () => {
      const fact = await this.resolveIndependentReviewerFact(goalId, source)
      return {
        kind: 'independent_reviewer',
        verdict: fact.verdict,
        source,
        summary: fact.summary,
        outputSha256: null,
      }
    })
  }

  async issuePlanVerificationReceipt(
    goalId: string,
    input: GoalPlanVerificationSource,
  ): Promise<GoalEvidenceReceipt> {
    const source = parsePlanVerificationSource(input)
    return await this.issueReceipt(goalId, async () => {
      const observation = await this.resolvePlanSourceObservation(
        goalId,
        source,
      )
      const fact = await this.resolvePlanVerificationFact(goalId, source)
      return {
        kind: 'plan_verification',
        verdict: 'pass',
        source,
        summary: fact.summary,
        outputSha256: observation.outputSha256,
      }
    })
  }

  private async issueReceipt(
    goalId: string,
    build: () => Promise<GoalEvidenceReceiptDraft>,
  ): Promise<GoalEvidenceReceipt> {
    return this.mutex.run(goalId, async () => {
      const id = requiredId(this.receiptIdFactory(), 'receipt ID')
      const createdAt = normalizeTimestamp(this.now())
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const goal = await this.requireActiveGoal(goalId)
        const input = await build()
        const receipt: GoalEvidenceReceipt = {
          id,
          goalId: goal.id,
          kind: input.kind,
          verdict: input.verdict,
          source: input.source,
          ...(input.kind === 'user_manual' && input.actionReceipt
            ? { actionReceipt: input.actionReceipt }
            : {}),
          summary: boundedSummary(input.summary),
          outputSha256: normalizeNullableSha256(input.outputSha256),
          createdAt,
        } as GoalEvidenceReceipt
        const existing = await this.listReceipts(goal.id)
        if (
          existing.some(
            (item) =>
              item.id === receipt.id ||
              receiptSourceKey(item) === receiptSourceKey(receipt),
          )
        ) {
          throw evidenceError(
            'goal_evidence_receipt_duplicate',
            'Goal evidence receipt source is already recorded.',
          )
        }
        const eventAt = maxTimestamp(goal.updatedAt, receipt.createdAt)
        const next = assertGoalTransition(goal, {
          ...goal,
          updatedAt: eventAt,
        })
        if (attempt === 1)
          await this.beforeReceiptAppendAttempt?.({
            goalId: goal.id,
            receipt,
            attempt,
            snapshotLastEventSeq: goal.lastEventSeq,
          })
        try {
          await this.store.append(goal.id, {
            type: 'goal_updated',
            record: next,
            createdAt: eventAt,
            expectedLastEventSeq: goal.lastEventSeq,
            data: { receipt: receipt as unknown as never },
          })
          return receipt
        } catch (error) {
          if (
            !(error instanceof GoalStoreError) ||
            error.code !== 'goal_event_conflict'
          )
            throw error
        }
      }
      throw evidenceError(
        'goal_evidence_concurrent_update',
        'Goal evidence receipt could not be merged after concurrent updates.',
      )
    })
  }

  async listEvidence(goalId: string): Promise<GoalEvidence[]> {
    const events = await this.store.readEvents(goalId)
    const output: GoalEvidence[] = []
    for (const event of events) {
      if (!isRecord(event.payload.evidence)) continue
      output.push(parseGoalEvidence(event.payload.evidence))
    }
    assertUniqueLedgerIds(output, 'goal_evidence_id_duplicate')
    return output
  }

  async listReceipts(goalId: string): Promise<GoalEvidenceReceipt[]> {
    const events = await this.store.readEvents(goalId)
    const output: GoalEvidenceReceipt[] = []
    for (const event of events) {
      if (!isGoalEvidenceReceiptPayload(event.payload.receipt)) continue
      output.push(parseGoalEvidenceReceipt(event.payload.receipt))
    }
    assertUniqueLedgerIds(output, 'goal_evidence_receipt_duplicate')
    return output
  }

  async latestEvidenceForCriterion(
    goalId: string,
    criterionId: string,
  ): Promise<GoalEvidence | null> {
    const goal = await this.store.get(goalId)
    if (!goal) return null
    const evidenceId = goal.latestEvidenceByCriterion[criterionId]
    if (!evidenceId) return null
    const evidence = (await this.listEvidence(goal.id)).find(
      (item) =>
        item.id === evidenceId &&
        item.goalId === goal.id &&
        item.criterionId === criterionId,
    )
    if (!evidence) return null
    try {
      const criterion = goal.contract.acceptanceCriteria.find(
        (item) => item.id === criterionId,
      )
      if (!criterion) return null
      const observations = await this.resolveObservations(
        goal.id,
        evidence.sourceObservationIds,
      )
      const receipts = await this.resolveReceipts(
        goal.id,
        evidence.sourceReceiptIds,
      )
      assertEligibleObservations(observations)
      assertVerificationCompatibility(
        criterion,
        evidence.verdict,
        observations,
        receipts,
      )
      return evidence
    } catch {
      return null
    }
  }

  /**
   * Re-resolve every source behind an existing evidence record. Consumers such
   * as the independent-review ledger must never trust an ID copied from model
   * text without walking the Goal ledger and observation/receipt facts again.
   */
  async validatedEvidenceById(
    goalId: string,
    evidenceId: string,
  ): Promise<GoalEvidence | null> {
    const goal = (await this.store.inspect(goalId)).record
    if (!goal) return null
    const evidence = (await this.listEvidenceReadonly(goal.id)).find(
      (item) => item.id === evidenceId && item.goalId === goal.id,
    )
    if (!evidence) return null
    const criterion = goal.contract.acceptanceCriteria.find(
      (item) => item.id === evidence.criterionId,
    )
    if (!criterion) return null
    try {
      const observations = await this.resolveObservations(
        goal.id,
        evidence.sourceObservationIds,
        true,
      )
      const receipts = await this.resolveReceipts(
        goal.id,
        evidence.sourceReceiptIds,
        true,
      )
      assertEligibleObservations(observations)
      assertVerificationCompatibility(
        criterion,
        evidence.verdict,
        observations,
        receipts,
      )
      return deepFreeze(structuredClone(evidence))
    } catch {
      return null
    }
  }

  async validatedReviewerEvidenceById(
    goalId: string,
    evidenceId: string,
    binding: {
      readonly taskId: string
      readonly agentId: string
      readonly dispatchedAt: string
    },
  ): Promise<GoalEvidence | null> {
    const evidence = await this.validatedEvidenceById(goalId, evidenceId)
    if (!evidence || evidence.sourceObservationIds.length === 0) return null
    try {
      const observations = await this.resolveObservations(
        goalId,
        evidence.sourceObservationIds,
        true,
      )
      const dispatchedAt = Date.parse(binding.dispatchedAt)
      if (
        !Number.isFinite(dispatchedAt) ||
        observations.length === 0 ||
        observations.some(
          (observation) =>
            observation.taskId !== binding.taskId ||
            observation.agentId !== binding.agentId ||
            Date.parse(observation.createdAt) < dispatchedAt,
        )
      )
        return null
      return evidence
    } catch {
      return null
    }
  }

  private async listEvidenceReadonly(goalId: string): Promise<GoalEvidence[]> {
    const events = await this.store.readEventsReadonly(goalId)
    const output: GoalEvidence[] = []
    for (const event of events) {
      if (!isRecord(event.payload.evidence)) continue
      output.push(parseGoalEvidence(event.payload.evidence))
    }
    assertUniqueLedgerIds(output, 'goal_evidence_id_duplicate')
    return output
  }

  private async listReceiptsReadonly(
    goalId: string,
  ): Promise<GoalEvidenceReceipt[]> {
    const events = await this.store.readEventsReadonly(goalId)
    const output: GoalEvidenceReceipt[] = []
    for (const event of events) {
      if (!isGoalEvidenceReceiptPayload(event.payload.receipt)) continue
      output.push(parseGoalEvidenceReceipt(event.payload.receipt))
    }
    assertUniqueLedgerIds(output, 'goal_evidence_receipt_duplicate')
    return output
  }

  private async requireActiveGoal(goalId: string): Promise<GoalRecord> {
    const goal = await this.store.get(goalId)
    if (!goal) throw evidenceError('goal_not_found', 'Goal does not exist.')
    if (goal.status !== 'active')
      throw evidenceError(
        'goal_evidence_goal_inactive',
        'Evidence can be recorded only for an active Goal.',
      )
    return goal
  }

  private async commitEvidenceWithRetry(
    evidence: GoalEvidence,
    initialLastEventSeq: number,
  ): Promise<void> {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const current = await this.requireActiveGoal(evidence.goalId)
      if (
        !current.contract.acceptanceCriteria.some(
          (item) => item.id === evidence.criterionId,
        )
      )
        throw evidenceError(
          'goal_evidence_criterion_unknown',
          'Goal acceptance criterion does not exist.',
        )
      const persisted = await this.listEvidence(current.id)
      if (persisted.some((item) => item.id === evidence.id))
        throw evidenceError(
          'goal_evidence_id_duplicate',
          'Goal evidence IDs must be unique.',
        )
      const latestId = current.latestEvidenceByCriterion[evidence.criterionId]
      const latest = latestId
        ? (persisted.find((item) => item.id === latestId) ?? null)
        : null
      const shouldProject =
        latest === null ||
        evidence.createdAt > latest.createdAt ||
        (evidence.createdAt === latest.createdAt &&
          current.lastEventSeq === initialLastEventSeq)
      const updatedAt = maxTimestamp(current.updatedAt, evidence.createdAt)
      const lastEvidenceAt = maxNullableTimestamp(
        current.runtime.lastEvidenceAt,
        evidence.createdAt,
      )
      const next = assertGoalTransition(current, {
        ...current,
        latestEvidenceByCriterion: shouldProject
          ? {
              ...current.latestEvidenceByCriterion,
              [evidence.criterionId]: evidence.id,
            }
          : { ...current.latestEvidenceByCriterion },
        runtime: { ...current.runtime, lastEvidenceAt },
        updatedAt,
      })
      if (attempt === 1)
        await this.beforeAppendAttempt?.({
          goalId: current.id,
          evidence,
          attempt,
          snapshotLastEventSeq: current.lastEventSeq,
        })
      try {
        await this.store.append(current.id, {
          type: 'goal_updated',
          record: next,
          createdAt: updatedAt,
          expectedLastEventSeq: current.lastEventSeq,
          data: { evidence: evidence as unknown as never },
        })
        return
      } catch (error) {
        if (
          !(error instanceof GoalStoreError) ||
          error.code !== 'goal_event_conflict'
        )
          throw error
      }
    }
    throw evidenceError(
      'goal_evidence_concurrent_update',
      'Goal evidence could not be merged after concurrent updates.',
    )
  }

  private async resolveObservations(
    goalId: string,
    sourceIds: readonly string[],
    readonly = false,
  ): Promise<GoalObservation[]> {
    const facts = await readObservationFacts(this.store, goalId, readonly)
    assertUniqueFactIds(facts)
    const byId = new Map(facts.map((item) => [item.id, item]))
    const output: GoalObservation[] = []
    for (const id of sourceIds) {
      const local = byId.get(id)
      if (local) {
        if (local.goalId !== goalId)
          throw evidenceError(
            'goal_evidence_source_cross_goal',
            'Goal evidence source belongs to another Goal.',
          )
        if (!verifyObservationIntegrity(local))
          throw evidenceError(
            'goal_observation_integrity_invalid',
            'Goal observation integrity check failed.',
          )
        output.push(local)
        continue
      }
      const foreignGoalId = readonly
        ? null
        : await findForeignObservationGoal(this.store, goalId, id)
      if (foreignGoalId)
        throw evidenceError(
          'goal_evidence_source_cross_goal',
          'Goal evidence source belongs to another Goal.',
        )
      throw evidenceError(
        'goal_evidence_source_unknown',
        'Goal evidence observation source does not exist.',
      )
    }
    return output
  }

  private async resolveReceipts(
    goalId: string,
    sourceIds: readonly string[],
    readonly = false,
  ): Promise<GoalEvidenceReceipt[]> {
    const local = readonly
      ? await this.listReceiptsReadonly(goalId)
      : await this.listReceipts(goalId)
    const byId = new Map(local.map((item) => [item.id, item]))
    const output: GoalEvidenceReceipt[] = []
    for (const id of sourceIds) {
      const receipt = byId.get(id)
      if (!receipt)
        throw evidenceError(
          'goal_evidence_receipt_unknown',
          'Goal evidence receipt source does not exist.',
        )
      if (receipt.goalId !== goalId)
        throw evidenceError(
          'goal_evidence_source_cross_goal',
          'Goal evidence receipt belongs to another Goal.',
        )
      await this.revalidateReceipt(receipt, readonly)
      output.push(receipt)
    }
    return output
  }

  private async revalidateReceipt(
    receipt: GoalEvidenceReceipt,
    readonly = false,
  ): Promise<void> {
    if (receipt.kind === 'user_manual') {
      const fact = await this.resolveUserManualFact(
        receipt.goalId,
        receipt.source,
      )
      if (
        fact.verdict !== receipt.verdict ||
        boundedSummary(fact.summary) !== receipt.summary ||
        (receipt.actionReceipt !== undefined &&
          canonicalJson(fact.actionReceipt) !==
            canonicalJson(receipt.actionReceipt))
      )
        throw untrustedReceiptFact()
      return
    }
    if (receipt.kind === 'independent_reviewer') {
      const fact = await this.resolveIndependentReviewerFact(
        receipt.goalId,
        receipt.source,
      )
      if (
        fact.verdict !== receipt.verdict ||
        boundedSummary(fact.summary) !== receipt.summary
      )
        throw untrustedReceiptFact()
      return
    }
    const observation = await this.resolvePlanSourceObservation(
      receipt.goalId,
      receipt.source,
      readonly,
    )
    const fact = await this.resolvePlanVerificationFact(
      receipt.goalId,
      receipt.source,
    )
    if (
      observation.outputSha256 !== receipt.outputSha256 ||
      boundedSummary(fact.summary) !== receipt.summary
    )
      throw untrustedReceiptFact()
  }

  private async resolveUserManualFact(
    goalId: string,
    source: GoalUserManualSource,
  ): Promise<GoalUserManualFact> {
    const fact = await this.factResolvers.resolveUserManual?.(goalId, source)
    if (
      !fact ||
      fact.goalId !== goalId ||
      !sameSource(fact, source) ||
      !fact.summary.trim()
    )
      throw untrustedReceiptFact()
    return fact
  }

  private async resolveIndependentReviewerFact(
    goalId: string,
    source: GoalIndependentReviewerSource,
  ): Promise<GoalIndependentReviewerFact> {
    const fact = await this.factResolvers.resolveIndependentReviewer?.(
      goalId,
      source,
    )
    if (
      !fact ||
      fact.goalId !== goalId ||
      !sameSource(fact, source) ||
      !fact.summary.trim()
    )
      throw untrustedReceiptFact()
    return fact
  }

  private async resolvePlanVerificationFact(
    goalId: string,
    source: GoalPlanVerificationSource,
  ): Promise<GoalPlanVerificationFact> {
    const fact = await this.factResolvers.resolvePlanVerification?.(
      goalId,
      source,
    )
    if (
      !fact ||
      fact.goalId !== goalId ||
      fact.passed !== true ||
      !sameSource(fact, source) ||
      !fact.summary.trim()
    )
      throw untrustedReceiptFact()
    return fact
  }

  private async resolvePlanSourceObservation(
    goalId: string,
    source: GoalPlanVerificationSource,
    readonly = false,
  ): Promise<GoalObservation> {
    const [observation] = await this.resolveObservations(
      goalId,
      [source.sourceObservationId],
      readonly,
    )
    if (
      !observation ||
      observation.toolCallId !== source.toolCallId ||
      observation.toolName !== 'run_command' ||
      observation.isError ||
      observation.toolInput.inputSha256 !== source.approvedInputHash
    )
      throw untrustedReceiptFact()
    assertEligibleObservations([observation])
    return observation
  }
}

export function computeGoalObservationOutputSha256(
  result: Pick<ToolResultObj, 'modelContent' | 'artifacts'>,
): string {
  return sha256(
    canonicalJson({
      modelContent: String(result.modelContent ?? ''),
      artifacts: artifactDescriptors(result),
    }),
  )
}

/** Hashes the Core-prepared tool input without persisting raw arguments. */
export function computeGoalToolInputSha256(
  toolNameValue: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): GoalToolInputDescriptor {
  const toolName = requiredText(toolNameValue, 'tool name')
  let canonicalArguments: string
  try {
    canonicalArguments = canonicalJson(argumentsValue)
  } catch {
    throw evidenceError(
      'goal_evidence_input_invalid',
      'tool arguments must be strict JSON.',
    )
  }
  return {
    toolName,
    argumentsSha256: sha256(canonicalArguments),
    inputSha256: sha256(canonicalJson({ toolName, arguments: argumentsValue })),
  }
}

export function verifyObservationIntegrity(
  observation: GoalObservation,
): boolean {
  try {
    const parsed = parseGoalObservation(observation)
    const { integritySha256: _integrity, ...base } = parsed
    return computeObservationIntegrity(base) === parsed.integritySha256
  } catch {
    return false
  }
}

function computeObservationIntegrity(
  observation: Omit<GoalObservation, 'integritySha256'>,
): string {
  return sha256(canonicalJson(observation))
}

function artifactDescriptors(
  result: Pick<ToolResultObj, 'artifacts'>,
): ManagedArtifactDescriptor[] {
  return result.artifacts
    .map(managedArtifactDescriptor)
    .filter((item): item is ManagedArtifactDescriptor => item !== null)
    .sort((left, right) => String(left.ref).localeCompare(String(right.ref)))
}

function managedArtifactDescriptor(
  artifact: ToolArtifact,
): ManagedArtifactDescriptor | null {
  const id = String(artifact.media?.id ?? '').trim()
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id)) return null
  return {
    ref: `media:${id}`,
    kind: 'media',
    bytes: Math.max(0, Math.trunc(Number(artifact.bytes) || 0)),
    mediaKind: artifact.media!.kind,
    mime: String(artifact.media!.mime || ''),
  }
}

async function readObservationFacts(
  store: GoalStore,
  goalId: string,
  readonly = false,
): Promise<GoalObservation[]> {
  const result = readonly
    ? await store.readObservationsReadonly<unknown>(goalId)
    : await store.readObservations<unknown>(goalId)
  if (result.badLines.length)
    throw evidenceError(
      'goal_observation_store_corrupt',
      'Goal observation journal contains malformed JSON.',
    )
  return result.records.map(parseGoalObservation)
}

function parseGoalObservation(value: unknown): GoalObservation {
  if (!isRecord(value))
    throw evidenceError(
      'goal_observation_integrity_invalid',
      'Goal observation is invalid.',
    )
  const policy = value.evidencePolicy
  if (
    policy !== 'eligible' &&
    policy !== 'context_only' &&
    policy !== 'forbidden'
  )
    throwInvalidObservation()
  if (
    typeof value.id !== 'string' ||
    typeof value.goalId !== 'string' ||
    typeof value.turnId !== 'string' ||
    typeof value.toolCallId !== 'string' ||
    typeof value.toolName !== 'string' ||
    !validOptionalTaskBinding(value.taskId, value.agentId) ||
    !isGoalToolInputDescriptor(value.toolInput, value.toolName) ||
    typeof value.eligible !== 'boolean' ||
    value.eligible !== (policy === 'eligible') ||
    typeof value.eligibilityReason !== 'string' ||
    typeof value.isError !== 'boolean' ||
    typeof value.outputSha256 !== 'string' ||
    !SHA256_PATTERN.test(value.outputSha256) ||
    typeof value.displaySummary !== 'string' ||
    value.displaySummary.length > SUMMARY_MAX_CHARS ||
    !Array.isArray(value.artifactRefs) ||
    !value.artifactRefs.every(isCoreArtifactRef) ||
    (value.runtimeEventSeq !== null &&
      (!Number.isInteger(value.runtimeEventSeq) ||
        Number(value.runtimeEventSeq) < 1)) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.integritySha256 !== 'string' ||
    !SHA256_PATTERN.test(value.integritySha256)
  )
    throwInvalidObservation()
  return value as unknown as GoalObservation
}

function reviewerTaskBinding(
  taskIdValue: string | null | undefined,
  agentIdValue: string | null | undefined,
): Pick<GoalObservation, 'taskId' | 'agentId'> {
  const taskId = String(taskIdValue ?? '').trim()
  const agentId = String(agentIdValue ?? '').trim()
  if (!taskId && !agentId) return {}
  if (!taskId || !agentId)
    throw evidenceError(
      'goal_observation_task_binding_invalid',
      'Reviewer task observations require both taskId and agentId.',
    )
  return { taskId, agentId }
}

function validOptionalTaskBinding(taskId: unknown, agentId: unknown): boolean {
  if (taskId === undefined && agentId === undefined) return true
  return (
    typeof taskId === 'string' &&
    taskId.trim().length > 0 &&
    typeof agentId === 'string' &&
    agentId.trim().length > 0
  )
}

function isGoalToolInputDescriptor(
  value: unknown,
  toolName: unknown,
): value is GoalToolInputDescriptor {
  return (
    isRecord(value) &&
    value.toolName === toolName &&
    typeof value.argumentsSha256 === 'string' &&
    SHA256_PATTERN.test(value.argumentsSha256) &&
    typeof value.inputSha256 === 'string' &&
    SHA256_PATTERN.test(value.inputSha256)
  )
}

function throwInvalidObservation(): never {
  throw evidenceError(
    'goal_observation_integrity_invalid',
    'Goal observation is invalid.',
  )
}

function parseGoalEvidence(value: unknown): GoalEvidence {
  if (!isRecord(value)) throw new Error('Goal evidence is invalid.')
  if (
    typeof value.id !== 'string' ||
    typeof value.goalId !== 'string' ||
    typeof value.criterionId !== 'string' ||
    (value.verdict !== 'pass' && value.verdict !== 'fail') ||
    typeof value.check !== 'string' ||
    typeof value.summary !== 'string' ||
    !Array.isArray(value.sourceObservationIds) ||
    !value.sourceObservationIds.every((item) => typeof item === 'string') ||
    !Array.isArray(value.sourceReceiptIds) ||
    !value.sourceReceiptIds.every((item) => typeof item === 'string') ||
    !['agent', 'reviewer', 'user', 'system'].includes(String(value.recorder)) ||
    typeof value.independent !== 'boolean' ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new Error('Goal evidence is invalid.')
  return value as unknown as GoalEvidence
}

function parseGoalEvidenceReceipt(value: unknown): GoalEvidenceReceipt {
  if (!isRecord(value)) throw new Error('Goal evidence receipt is invalid.')
  if (
    typeof value.id !== 'string' ||
    typeof value.goalId !== 'string' ||
    !['user_manual', 'plan_verification', 'independent_reviewer'].includes(
      String(value.kind),
    ) ||
    (value.verdict !== 'pass' && value.verdict !== 'fail') ||
    typeof value.summary !== 'string' ||
    (value.outputSha256 !== null &&
      (typeof value.outputSha256 !== 'string' ||
        !SHA256_PATTERN.test(value.outputSha256))) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new Error('Goal evidence receipt is invalid.')
  if (value.kind === 'user_manual') {
    return {
      ...value,
      source: parseUserManualSource(value.source),
      ...(value.actionReceipt !== undefined
        ? { actionReceipt: parseUserManualActionReceipt(value.actionReceipt) }
        : {}),
    } as unknown as GoalEvidenceReceipt
  }
  if (value.kind === 'independent_reviewer') {
    return {
      ...value,
      source: parseIndependentReviewerSource(value.source),
    } as unknown as GoalEvidenceReceipt
  }
  if (value.verdict !== 'pass' || typeof value.outputSha256 !== 'string')
    throw new Error('Goal evidence receipt is invalid.')
  return {
    ...value,
    source: parsePlanVerificationSource(value.source),
  } as unknown as GoalEvidenceReceipt
}

function isGoalEvidenceReceiptPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    ['user_manual', 'plan_verification', 'independent_reviewer'].includes(
      String(value.kind),
    )
  )
}

function parseUserManualActionReceipt(
  value: unknown,
): GoalUserManualActionReceipt {
  if (!isRecord(value) || !isRecord(value.question))
    throw untrustedReceiptFact()
  const receipt: GoalUserManualActionReceipt = {
    schemaVersion:
      value.schemaVersion === 'cairn.goal.user-manual-action.v1'
        ? value.schemaVersion
        : failManualReceipt(),
    issuedBy: value.issuedBy === 'core' ? 'core' : failManualReceipt(),
    action:
      value.action === 'record_goal_manual_verification'
        ? value.action
        : failManualReceipt(),
    interactionId: requiredId(value.interactionId, 'interaction ID'),
    goalId: requiredId(value.goalId, 'goal ID'),
    goalEventSeq: Number(value.goalEventSeq),
    criterionId: requiredId(value.criterionId, 'criterion ID'),
    verdict: requiredVerdict(value.verdict),
    source: value.source === 'user' ? 'user' : failManualReceipt(),
    question: structuredClone(value.question),
    coreSignature: String(value.coreSignature ?? ''),
  }
  if (
    !Number.isSafeInteger(receipt.goalEventSeq) ||
    receipt.goalEventSeq < 1 ||
    !/^[a-f0-9]{64}$/.test(receipt.coreSignature)
  )
    throw untrustedReceiptFact()
  return Object.freeze(receipt)
}

function failManualReceipt(): never {
  throw untrustedReceiptFact()
}

function parseUserManualSource(value: unknown): GoalUserManualSource {
  if (!isRecord(value)) throw untrustedReceiptFact()
  return {
    interactionId: requiredId(value.interactionId, 'interaction ID'),
    criterionId: requiredId(value.criterionId, 'criterion ID'),
    verdict: requiredVerdict(value.verdict),
  }
}

function parseIndependentReviewerSource(
  value: unknown,
): GoalIndependentReviewerSource {
  if (!isRecord(value)) throw untrustedReceiptFact()
  const transcriptRef = requiredText(value.transcriptRef, 'transcript ref')
  if (!isTaskTranscriptRef(transcriptRef)) throw untrustedReceiptFact()
  const extended = value.reviewerReceiptId !== undefined
  return {
    ...(extended
      ? {
          reviewerReceiptId: requiredId(
            value.reviewerReceiptId,
            'reviewer receipt ID',
          ),
          dispatchReceiptId: requiredId(
            value.dispatchReceiptId,
            'reviewer dispatch receipt ID',
          ),
          dispatchOrdinal: requiredPositiveInteger(
            value.dispatchOrdinal,
            'reviewer dispatch ordinal',
          ),
          planId: requiredId(value.planId, 'plan ID'),
          planEventSeq: requiredPositiveInteger(
            value.planEventSeq,
            'plan event sequence',
          ),
          agentId: requiredId(value.agentId, 'review agent ID'),
          transcriptSha256: requiredSha256Value(
            value.transcriptSha256,
            'transcript SHA-256',
          ),
          riskFactVersion:
            value.riskFactVersion === null
              ? null
              : requiredId(value.riskFactVersion, 'risk fact version'),
          riskSignalsSha256: requiredSha256Value(
            value.riskSignalsSha256,
            'risk signals SHA-256',
          ),
          commandObservationsSha256: requiredSha256Value(
            value.commandObservationsSha256,
            'command observations SHA-256',
          ),
        }
      : {}),
    taskId: requiredId(value.taskId, 'review task ID'),
    transcriptRef,
    criterionId: requiredId(value.criterionId, 'criterion ID'),
    verdict: requiredVerdict(value.verdict),
  }
}

function parsePlanVerificationSource(
  value: unknown,
): GoalPlanVerificationSource {
  if (!isRecord(value)) throw untrustedReceiptFact()
  const approvedInputHash = String(value.approvedInputHash ?? '')
  if (!SHA256_PATTERN.test(approvedInputHash)) throw untrustedReceiptFact()
  return {
    planId: requiredId(value.planId, 'plan ID'),
    stepId: requiredId(value.stepId, 'plan step ID'),
    requirementId: requiredId(value.requirementId, 'plan requirement ID'),
    toolCallId: requiredId(value.toolCallId, 'tool call ID'),
    sourceObservationId: requiredId(
      value.sourceObservationId,
      'source observation ID',
    ),
    approvedInputHash,
  }
}

function requiredVerdict(value: unknown): 'pass' | 'fail' {
  if (value !== 'pass' && value !== 'fail') throw untrustedReceiptFact()
  return value
}

function receiptSourceKey(receipt: GoalEvidenceReceipt): string {
  return canonicalJson({ kind: receipt.kind, source: receipt.source })
}

function sameSource(fact: object, source: object): boolean {
  const values = fact as Record<string, unknown>
  return Object.entries(source).every(([key, value]) => values[key] === value)
}

function assertUniqueFactIds(facts: readonly GoalObservation[]): void {
  const ids = new Set<string>()
  for (const fact of facts) {
    if (ids.has(fact.id))
      throw evidenceError(
        'goal_observation_id_duplicate',
        'Goal observation IDs must be unique.',
      )
    ids.add(fact.id)
  }
}

function assertUniqueLedgerIds(
  records: readonly { readonly id: string }[],
  code: string,
): void {
  const ids = new Set<string>()
  for (const record of records) {
    if (ids.has(record.id))
      throw evidenceError(code, 'Goal ledger record IDs must be unique.')
    ids.add(record.id)
  }
}

async function findForeignObservationGoal(
  store: GoalStore,
  currentGoalId: string,
  observationId: string,
): Promise<string | null> {
  for (const goal of await store.list()) {
    if (goal.id === currentGoalId) continue
    let observations: GoalObservation[]
    try {
      observations = await readObservationFacts(store, goal.id)
    } catch {
      continue
    }
    if (observations.some((item) => item.id === observationId)) return goal.id
  }
  return null
}

function assertEligibleObservations(
  observations: readonly GoalObservation[],
): void {
  for (const observation of observations) {
    if (
      observation.evidencePolicy !== 'eligible' ||
      observation.eligible !== true
    )
      throw evidenceError(
        'goal_evidence_source_ineligible',
        'Goal evidence source is not eligible.',
      )
  }
}

function assertVerificationCompatibility(
  criterion: GoalAcceptanceCriterion,
  verdict: GoalEvidence['verdict'],
  observations: readonly GoalObservation[],
  receipts: readonly GoalEvidenceReceipt[],
): void {
  if (verdict === 'pass' && observations.some((item) => item.isError))
    throw evidenceError(
      'goal_evidence_source_failed',
      'Failed tool executions cannot prove PASS evidence.',
    )
  const kind = criterion.verification.kind
  if (kind === 'command') {
    const expected = computeGoalToolInputSha256('run_command', {
      command: criterion.verification.requirement,
    })
    if (
      observations.every(
        (item) =>
          item.toolName === 'run_command' &&
          item.toolInput.inputSha256 === expected.inputSha256 &&
          item.isError === (verdict === 'fail'),
      ) &&
      receipts.every(
        (item) =>
          item.kind === 'plan_verification' &&
          verdict === 'pass' &&
          item.source.approvedInputHash === expected.inputSha256,
      ) &&
      (observations.length > 0 || receipts.length > 0)
    )
      return
  } else if (kind === 'artifact') {
    if (
      receipts.length === 0 &&
      observations.length > 0 &&
      observations.every(
        (item) =>
          item.artifactRefs.length > 0 && item.isError === (verdict === 'fail'),
      )
    )
      return
  } else if (kind === 'manual') {
    if (
      observations.length === 0 &&
      receipts.length > 0 &&
      receipts.every(
        (item) =>
          item.kind === 'user_manual' &&
          item.source.criterionId === criterion.id &&
          item.verdict === verdict,
      )
    )
      return
  } else if (kind === 'reviewer') {
    const reviewer = receipts.some(
      (item) =>
        item.kind === 'independent_reviewer' &&
        item.source.criterionId === criterion.id &&
        item.verdict === verdict,
    )
    const receiptsCompatible = receipts.every(
      (item) =>
        item.kind === 'independent_reviewer' &&
        item.source.criterionId === criterion.id &&
        item.verdict === verdict,
    )
    // Independent reviewer receipts are revalidated against their exact
    // terminal Task, transcript, risk frontier, and task-owned command
    // observations. Reviewer ACs must not borrow observations from another AC.
    const productionGrounded = receipts.every(
      (item) =>
        item.kind === 'independent_reviewer' &&
        Boolean(item.source.reviewerReceiptId),
    )
    if (
      reviewer &&
      receiptsCompatible &&
      ((productionGrounded && observations.length === 0) ||
        (!productionGrounded && observations.length > 0))
    )
      return
    if (reviewer)
      throw evidenceError(
        'goal_evidence_reviewer_grounding_required',
        'Reviewer evidence requires an exact production reviewer receipt.',
      )
  }
  throw evidenceError(
    verdict === 'fail'
      ? 'goal_evidence_failure_source_required'
      : 'goal_evidence_verification_incompatible',
    `Evidence sources are incompatible with ${kind} verification.`,
  )
}

function uniqueSortedIds(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values))
    throw evidenceError(
      'goal_evidence_source_invalid',
      `Goal evidence ${label} sources are invalid.`,
    )
  const output = values.map((value) => requiredId(value, `${label} source ID`))
  if (new Set(output).size !== output.length)
    throw evidenceError(
      'goal_evidence_source_duplicate',
      'Goal evidence source IDs must be unique.',
    )
  return output.sort()
}

function normalizeArtifactRefs(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function isCoreArtifactRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (/^media:[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value) ||
      isTaskTranscriptRef(value))
  )
}

function isTaskTranscriptRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^task:[A-Za-z0-9_-][A-Za-z0-9_.:-]*:transcript$/.test(value)
  )
}

function eligibilityReason(policy: ToolEvidencePolicy): string {
  if (policy === 'eligible') return 'tool explicitly opted in to Goal evidence'
  if (policy === 'forbidden')
    return 'tool is forbidden from proving Goal completion'
  return 'tool output is context only'
}

function boundedSummary(value: string): string {
  return redactSensitiveOutput(String(value ?? '')).slice(0, SUMMARY_MAX_CHARS)
}

function boundedRequiredText(
  value: string,
  label: string,
  limit: number,
): string {
  const text = requiredText(value, label)
  return text.slice(0, limit)
}

function requiredText(value: unknown, label: string): string {
  const text = String(value ?? '').trim()
  if (!text)
    throw evidenceError('goal_evidence_input_invalid', `${label} is required.`)
  return text
}

function requiredId(value: unknown, label: string): string {
  const id = requiredText(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id))
    throw evidenceError('goal_evidence_input_invalid', `${label} is invalid.`)
  return id
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw evidenceError(
      'goal_evidence_receipt_fact_untrusted',
      `${label} is invalid.`,
    )
  return parsed
}

function requiredSha256Value(value: unknown, label: string): string {
  const hash = String(value ?? '')
  if (!SHA256_PATTERN.test(hash))
    throw evidenceError(
      'goal_evidence_receipt_fact_untrusted',
      `${label} is invalid.`,
    )
  return hash
}

function normalizeRuntimeEventSeq(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isInteger(value) || value < 1)
    throw evidenceError(
      'goal_evidence_input_invalid',
      'runtime event sequence is invalid.',
    )
  return value
}

function normalizeTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)))
    throw evidenceError('goal_evidence_input_invalid', 'timestamp is invalid.')
  return value
}

function maxTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function maxNullableTimestamp(left: string | null, right: string): string {
  return left === null ? right : maxTimestamp(left, right)
}

function normalizeNullableSha256(value: string | null): string | null {
  if (value === null) return null
  if (!SHA256_PATTERN.test(value))
    throw evidenceError(
      'goal_evidence_input_invalid',
      'receipt output hash is invalid.',
    )
  return value
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function evidenceError(code: string, message: string): GoalEvidenceError {
  return new GoalEvidenceError(code, message)
}

function untrustedReceiptFact(): GoalEvidenceError {
  return evidenceError(
    'goal_evidence_receipt_fact_untrusted',
    'Goal evidence receipt fact is unavailable or no longer trusted.',
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value))
    return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

class AsyncKeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
