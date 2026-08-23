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

export const GOAL_PERMISSION_BLOCKER_QUESTION_ID =
  'goal_permission_blocker_resolution'
export const GOAL_PERMISSION_BLOCKER_DENIED_LABEL = 'Permission is unavailable'
export const GOAL_PERMISSION_BLOCKER_RETRY_LABEL = 'Retry with permission'

export interface GoalBlockerControlResolution {
  readonly cause: 'missing_permission'
  readonly receiptId: string
}

/** Dedicated Core interaction; generic Ask metadata cannot mint blocker authority. */
export class GoalBlockerControlManager {
  private readonly signer: CoreControlActionSigner

  constructor(private readonly cm: ControlManagerHost) {
    this.signer = new CoreControlActionSigner(cm.store.root)
  }

  requestPermissionResolution(goal: GoalRecord, reason: string): Interaction {
    if (goal.status !== 'active')
      throw new Error('Only an active Goal can request blocker resolution.')
    const normalizedReason = String(reason ?? '').trim()
    if (!normalizedReason)
      throw new Error('Goal permission blocker reason is required.')
    this.cm.ensureNoPending()
    const interaction = makeAsk({
      questions: [
        questionFromDict({
          id: GOAL_PERMISSION_BLOCKER_QUESTION_ID,
          header: 'Permission',
          question:
            'A required permission is unavailable. Can it be granted, or is the Goal blocked?',
          options: [
            {
              label: GOAL_PERMISSION_BLOCKER_RETRY_LABEL,
              description: 'Grant access and keep the Goal active.',
            },
            {
              label: GOAL_PERMISSION_BLOCKER_DENIED_LABEL,
              description:
                'Confirm that the missing permission blocks the Goal.',
            },
          ],
        }),
      ],
      context: normalizedReason,
      meta: {},
    })
    const request = {
      version: 1,
      issued_by: 'core',
      action: 'confirm_goal_permission_blocker',
      interaction_id: interaction.id,
      goal_id: goal.id,
      goal_event_seq: goal.lastEventSeq,
      cause: 'missing_permission',
      question: questionIdentity(interaction),
    }
    interaction.meta = {
      goal_permission_blocker_request: {
        ...request,
        core_signature: this.signer.sign(request),
      },
    }
    this.cm.setPending(interaction)
    return interaction
  }

  resolvePermissionDenial(
    goal: GoalRecord,
    interactionId: string,
    options: { readonly allowHistoricalReceipt?: boolean } = {},
  ): GoalBlockerControlResolution | null {
    const interaction = this.cm.store.inspect().record?.lastInteraction
    if (
      !interaction ||
      interaction.id !== interactionId ||
      interaction.kind !== 'ask' ||
      interaction.status !== InteractionStatus.ANSWERED
    )
      return null
    const raw = interaction.meta.goal_permission_blocker_request
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const request = raw as Record<string, unknown>
    const signed = {
      version: request.version,
      issued_by: request.issued_by,
      action: request.action,
      interaction_id: request.interaction_id,
      goal_id: request.goal_id,
      goal_event_seq: request.goal_event_seq,
      cause: request.cause,
      question: request.question,
    }
    if (
      request.version !== 1 ||
      request.issued_by !== 'core' ||
      request.action !== 'confirm_goal_permission_blocker' ||
      request.interaction_id !== interaction.id ||
      request.goal_id !== goal.id ||
      !(
        Number(request.goal_event_seq) === goal.lastEventSeq ||
        (options.allowHistoricalReceipt === true &&
          Number(request.goal_event_seq) < goal.lastEventSeq)
      ) ||
      request.cause !== 'missing_permission' ||
      canonicalJson(request.question as never) !==
        canonicalJson(questionIdentity(interaction) as never) ||
      !this.signer.verify(signed, request.core_signature)
    )
      return null
    const answer = interaction.answers[GOAL_PERMISSION_BLOCKER_QUESTION_ID]
    if (
      !answer ||
      typeof answer !== 'object' ||
      Array.isArray(answer) ||
      String((answer as Record<string, unknown>).choice ?? '') !==
        GOAL_PERMISSION_BLOCKER_DENIED_LABEL
    )
      return null
    return Object.freeze({
      cause: 'missing_permission',
      receiptId: interaction.id,
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
