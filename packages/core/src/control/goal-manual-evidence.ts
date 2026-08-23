import type {
  GoalUserManualActionReceipt,
  GoalUserManualFact,
  GoalUserManualSource,
} from '../goals/evidence'
import type { GoalRecord } from '../goals/models'
import {
  InteractionStatus,
  makeAsk,
  questionFromDict,
  type Interaction,
} from './models'
import type { ControlManagerHost } from './host'
import { CoreControlActionSigner } from './core-action-signature'
import { canonicalJson } from '../goals/events'

export const GOAL_MANUAL_EVIDENCE_QUESTION_ID = 'goal_manual_verification'
export const GOAL_MANUAL_EVIDENCE_PASS_LABEL = 'Manual check passed'
export const GOAL_MANUAL_EVIDENCE_FAIL_LABEL = 'Manual check failed'
export const GOAL_MANUAL_EVIDENCE_DECLINE_LABEL = 'Decline to verify'

export class GoalManualEvidenceControlManager {
  private readonly signer: CoreControlActionSigner

  constructor(private readonly cm: ControlManagerHost) {
    this.signer = new CoreControlActionSigner(cm.store.root)
  }

  request(goal: GoalRecord, criterionId: string): Interaction {
    const criterion = goal.contract.acceptanceCriteria.find(
      (candidate) => candidate.id === criterionId,
    )
    if (
      goal.status !== 'active' ||
      !criterion ||
      criterion.verification.kind !== 'manual'
    )
      throw new Error('Goal manual criterion is unavailable.')
    this.cm.ensureNoPending()
    const interaction = makeAsk({
      questions: [
        questionFromDict({
          id: GOAL_MANUAL_EVIDENCE_QUESTION_ID,
          header: 'Verification',
          question: criterion.description,
          options: [
            {
              label: GOAL_MANUAL_EVIDENCE_PASS_LABEL,
              description: 'Record an explicit user PASS for this criterion.',
            },
            {
              label: GOAL_MANUAL_EVIDENCE_FAIL_LABEL,
              description: 'Record an explicit user FAIL for this criterion.',
            },
            {
              label: GOAL_MANUAL_EVIDENCE_DECLINE_LABEL,
              description: 'Do not create manual evidence.',
            },
          ],
        }),
      ],
      context: criterion.verification.requirement,
      meta: {},
    })
    const request = {
      version: 1,
      issued_by: 'core',
      action: 'record_goal_manual_verification',
      interaction_id: interaction.id,
      goal_id: goal.id,
      goal_event_seq: goal.lastEventSeq,
      criterion_id: criterion.id,
      question_id: GOAL_MANUAL_EVIDENCE_QUESTION_ID,
      question: questionIdentity(interaction),
    }
    interaction.meta = {
      goal_manual_evidence_request: {
        ...request,
        core_signature: this.signer.sign(request),
      },
    }
    this.cm.setPending(interaction)
    return interaction
  }

  resolve(
    goal: GoalRecord,
    source: GoalUserManualSource,
    options: { readonly allowHistoricalReceipt?: boolean } = {},
  ): GoalUserManualFact | null {
    const interaction = this.cm.store.inspect().record?.lastInteraction
    if (
      !interaction ||
      interaction.id !== source.interactionId ||
      interaction.kind !== 'ask' ||
      interaction.status !== InteractionStatus.ANSWERED
    )
      return null
    const raw = interaction.meta.goal_manual_evidence_request
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const request = raw as Record<string, unknown>
    const signed = {
      version: request.version,
      issued_by: request.issued_by,
      action: request.action,
      interaction_id: request.interaction_id,
      goal_id: request.goal_id,
      goal_event_seq: request.goal_event_seq,
      criterion_id: request.criterion_id,
      question_id: request.question_id,
      question: request.question,
    }
    const criterion = goal.contract.acceptanceCriteria.find(
      (candidate) => candidate.id === source.criterionId,
    )
    if (
      request.version !== 1 ||
      request.issued_by !== 'core' ||
      request.action !== 'record_goal_manual_verification' ||
      request.interaction_id !== interaction.id ||
      request.goal_id !== goal.id ||
      !(
        Number(request.goal_event_seq) === goal.lastEventSeq ||
        (options.allowHistoricalReceipt === true &&
          Number(request.goal_event_seq) < goal.lastEventSeq)
      ) ||
      request.criterion_id !== source.criterionId ||
      request.question_id !== GOAL_MANUAL_EVIDENCE_QUESTION_ID ||
      canonicalJson(request.question as never) !==
        canonicalJson(questionIdentity(interaction) as never) ||
      !this.signer.verify(signed, request.core_signature) ||
      !criterion ||
      criterion.verification.kind !== 'manual'
    )
      return null
    const answer = interaction.answers[GOAL_MANUAL_EVIDENCE_QUESTION_ID]
    if (!answer || typeof answer !== 'object' || Array.isArray(answer))
      return null
    const choice = String((answer as Record<string, unknown>).choice ?? '')
    const verdict =
      choice === GOAL_MANUAL_EVIDENCE_PASS_LABEL
        ? 'pass'
        : choice === GOAL_MANUAL_EVIDENCE_FAIL_LABEL
          ? 'fail'
          : null
    if (!verdict || verdict !== source.verdict) return null
    const actionReceipt = this.issueActionReceipt(
      goal,
      source,
      Number(request.goal_event_seq),
      questionIdentity(interaction),
    )
    return Object.freeze({
      ...source,
      goalId: goal.id,
      summary: `User explicitly recorded manual ${verdict}.`,
      actionReceipt,
    })
  }

  verifyDurableAction(
    goal: GoalRecord,
    source: GoalUserManualSource,
    value: unknown,
  ): GoalUserManualFact | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const receipt = value as Record<string, unknown>
    const criterion = goal.contract.acceptanceCriteria.find(
      (candidate) => candidate.id === source.criterionId,
    )
    const signed = {
      schemaVersion: receipt.schemaVersion,
      issuedBy: receipt.issuedBy,
      action: receipt.action,
      interactionId: receipt.interactionId,
      goalId: receipt.goalId,
      goalEventSeq: receipt.goalEventSeq,
      criterionId: receipt.criterionId,
      verdict: receipt.verdict,
      source: receipt.source,
      question: receipt.question,
    }
    if (
      receipt.schemaVersion !== 'cairn.goal.user-manual-action.v1' ||
      receipt.issuedBy !== 'core' ||
      receipt.action !== 'record_goal_manual_verification' ||
      receipt.interactionId !== source.interactionId ||
      receipt.goalId !== goal.id ||
      !Number.isSafeInteger(Number(receipt.goalEventSeq)) ||
      Number(receipt.goalEventSeq) < 1 ||
      Number(receipt.goalEventSeq) > goal.lastEventSeq ||
      receipt.criterionId !== source.criterionId ||
      receipt.verdict !== source.verdict ||
      receipt.source !== 'user' ||
      !criterion ||
      criterion.verification.kind !== 'manual' ||
      canonicalJson(receipt.question as never) !==
        canonicalJson(expectedQuestionIdentity(criterion) as never) ||
      !this.signer.verify(signed, receipt.coreSignature)
    )
      return null
    return Object.freeze({
      ...source,
      goalId: goal.id,
      summary: `User explicitly recorded manual ${source.verdict}.`,
      actionReceipt: Object.freeze({
        ...signed,
        coreSignature: String(receipt.coreSignature),
      }) as GoalUserManualActionReceipt,
    })
  }

  private issueActionReceipt(
    goal: GoalRecord,
    source: GoalUserManualSource,
    goalEventSeq: number,
    question: Record<string, unknown>,
  ): GoalUserManualActionReceipt {
    const payload = {
      schemaVersion: 'cairn.goal.user-manual-action.v1' as const,
      issuedBy: 'core' as const,
      action: 'record_goal_manual_verification' as const,
      interactionId: source.interactionId,
      goalId: goal.id,
      goalEventSeq,
      criterionId: source.criterionId,
      verdict: source.verdict,
      source: 'user' as const,
      question,
    }
    return Object.freeze({
      ...payload,
      coreSignature: this.signer.sign(payload),
    })
  }
}

function questionIdentity(interaction: Interaction): Record<string, unknown> {
  if (interaction.questions.length !== 1)
    return { invalid_question_count: interaction.questions.length }
  const question = interaction.questions[0]!
  return {
    id: question.id,
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
  }
}

function expectedQuestionIdentity(
  criterion: GoalRecord['contract']['acceptanceCriteria'][number],
): Record<string, unknown> {
  return {
    id: GOAL_MANUAL_EVIDENCE_QUESTION_ID,
    header: 'Verification',
    question: criterion.description,
    options: [
      {
        label: GOAL_MANUAL_EVIDENCE_PASS_LABEL,
        description: 'Record an explicit user PASS for this criterion.',
      },
      {
        label: GOAL_MANUAL_EVIDENCE_FAIL_LABEL,
        description: 'Record an explicit user FAIL for this criterion.',
      },
      {
        label: GOAL_MANUAL_EVIDENCE_DECLINE_LABEL,
        description: 'Do not create manual evidence.',
      },
    ],
  }
}
