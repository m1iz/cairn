import type { AgentLoop } from '../../agent/loop'
import type { ControlResume } from '../../control/manager'
import type { ControlStatePayload } from '../../control/models'
import {
  GOAL_MANUAL_EVIDENCE_DECLINE_LABEL,
  GOAL_MANUAL_EVIDENCE_FAIL_LABEL,
  GOAL_MANUAL_EVIDENCE_PASS_LABEL,
  GOAL_MANUAL_EVIDENCE_QUESTION_ID,
} from '../../control/goal-manual-evidence'
import {
  GOAL_PERMISSION_BLOCKER_DENIED_LABEL,
  GOAL_PERMISSION_BLOCKER_QUESTION_ID,
} from '../../control/goal-blocker'
import { planToDict } from '../../plans/models'
import type { MainlineTurnService } from '../chat-service'

type Dict = Record<string, unknown>
type StreamEmitter = (event: Dict) => void | Promise<void>

export interface InteractionResumeOptions {
  clientMessageId?: string | null
  turnId?: string | null
  displayContent?: string | null
  uiHidden?: boolean | null
  emit?: StreamEmitter | null
}

export interface InteractionRuntimeEmitter {
  (
    event: Dict,
    options?: { emit?: StreamEmitter | null; sessionId?: string | null },
  ): Promise<Dict>
}

/**
 * Owns user-interaction commands and their continuation semantics.
 * The Core API remains a transport facade while this service coordinates the
 * existing control, Plan, Goal, event, and mainline application services.
 */
export class CoreInteractionService {
  constructor(
    private readonly loop: AgentLoop,
    private readonly mainline: MainlineTurnService,
    private readonly emitRuntime: InteractionRuntimeEmitter,
  ) {}

  get(): ControlStatePayload {
    return this.loop.controlManager.payload()
  }

  setPermissionMode(mode: string): ControlStatePayload {
    return this.loop.controlManager.setPermissionMode(mode)
  }

  setMode(mode: string): Promise<ControlStatePayload> {
    return this.loop.setControlMode(mode)
  }

  async answerInteraction(
    id: string,
    answers: Dict,
    options: InteractionResumeOptions = {},
  ): Promise<Dict> {
    const ownerSessionId = this.loop.controlPendingOwnerSessionId(id)
    const isProfileOnboarding = this.loop.isProfileOnboardingInteraction(id)
    const pending = this.loop.controlManager.store.load().pending
    const resume = this.loop.controlManager.answer(id, answers)
    const answered = this.loop.controlManager.store.load().lastInteraction
    const manualRequest =
      pending?.id === id && isRecord(pending.meta.goal_manual_evidence_request)
        ? pending.meta.goal_manual_evidence_request
        : null
    const permissionRequest =
      pending?.id === id &&
      isRecord(pending.meta.goal_permission_blocker_request)
        ? pending.meta.goal_permission_blocker_request
        : null

    if (manualRequest) {
      const goalId = String(manualRequest.goal_id ?? '').trim()
      const criterionId = String(manualRequest.criterion_id ?? '').trim()
      const choice = interactionAnswerChoice(
        answered,
        GOAL_MANUAL_EVIDENCE_QUESTION_ID,
      )
      const verdict =
        choice === GOAL_MANUAL_EVIDENCE_PASS_LABEL
          ? 'pass'
          : choice === GOAL_MANUAL_EVIDENCE_FAIL_LABEL
            ? 'fail'
            : null
      if (goalId && criterionId && verdict) {
        await this.loop.recordGoalManualVerification(goalId, {
          interactionId: id,
          criterionId,
          verdict,
        })
      } else if (goalId && choice === GOAL_MANUAL_EVIDENCE_DECLINE_LABEL) {
        await this.loop.goalCoordinator.pause(
          goalId,
          'manual_verification_declined',
        )
        return await this.resumeControl(
          { ...resume, resume: false },
          options,
          ownerSessionId,
        )
      }
    }

    if (permissionRequest) {
      const goalId = String(permissionRequest.goal_id ?? '').trim()
      const choice = interactionAnswerChoice(
        answered,
        GOAL_PERMISSION_BLOCKER_QUESTION_ID,
      )
      if (goalId && choice === GOAL_PERMISSION_BLOCKER_DENIED_LABEL) {
        await this.loop.goalCoordinator.settleControl(goalId, id)
        await this.loop.blockGoalFromControlPermissionDenial(
          goalId,
          {
            code: 'missing_permission',
            reason: String(pending?.context ?? 'Required permission denied.'),
          },
          id,
        )
        return await this.resumeControl(
          { ...resume, resume: false },
          options,
          ownerSessionId,
        )
      }
    }
    const result = await this.resumeControl(resume, options, ownerSessionId)
    if (isProfileOnboarding) {
      return {
        ...result,
        profileOnboarding: this.loop.profileOnboardingPayload(),
      }
    }
    return result
  }

  commentPlan(
    id: string,
    comment: string,
    options: InteractionResumeOptions = {},
  ): Promise<Dict> {
    const ownerSessionId = this.loop.controlPendingOwnerSessionId(id)
    return this.resumeControl(
      this.loop.controlManager.comment(id, comment),
      options,
      ownerSessionId,
    )
  }

  async approvePlan(
    id: string,
    options: InteractionResumeOptions = {},
  ): Promise<Dict> {
    const ownerSessionId = this.loop.controlPendingOwnerSessionId(id)
    const pending = this.loop.controlManager.payload().pending
    const pendingMeta =
      isRecord(pending) && isRecord(pending.meta) ? pending.meta : null
    const pendingPlanId = String(pendingMeta?.plan_id ?? '').trim()
    const pendingPlan = pendingPlanId
      ? this.loop.controlManager.planStore.get(pendingPlanId)
      : null
    if (pendingPlan?.goalId) {
      const approvalInput = {
        goalId: pendingPlan.goalId,
        planId: pendingPlan.id,
        interactionId: id,
        approvalGeneration: Number(
          pendingMeta?.approval_generation ?? Number.NaN,
        ),
      }
      await this.loop.goalPlanBridge.preflightApproval(approvalInput)
      await this.loop.goalPlanBridge.prepareApproval(approvalInput)
    }
    const resume = await (async () => {
      try {
        const approval = this.loop.controlManager.approve(id)
        const planPayload = isRecord(approval.event.plan)
          ? approval.event.plan
          : null
        const planId = String(planPayload?.id ?? '').trim()
        if (planId) {
          const plan = this.loop.controlManager.planStore.get(planId)
          if (plan?.goalId) {
            await this.loop.goalPlanBridge.bindApprovedPlan({
              goalId: plan.goalId,
              planId,
            })
            const rebound = this.loop.controlManager.planStore.get(planId)
            if (rebound) approval.event.plan = planToDict(rebound)
          }
        }
        return approval
      } catch (cause) {
        if (pendingPlan?.goalId)
          this.loop.goalPlanBridge.abortFailedApproval({
            goalId: pendingPlan.goalId,
            planId: pendingPlan.id,
          })
        throw cause
      }
    })()
    return this.resumeControl(resume, options, ownerSessionId)
  }

  async cancelInteraction(id: string): Promise<Dict> {
    const ownerSessionId = this.loop.controlPendingOwnerSessionId(id)
    const result = this.loop.controlManager.cancel(id)
    const event: Dict = {
      ...result,
      control: this.loop.controlManager.payload(),
    }
    await this.emitRuntime(event, { sessionId: ownerSessionId })
    if (
      ownerSessionId &&
      event.event === 'plan_execution_settled' &&
      event.disposition === 'pause'
    )
      this.loop.clearSessionCheckpoint(ownerSessionId)
    await this.loop.deferProfileInterview(id)
    return event
  }

  private async resumeControl(
    resume: ControlResume,
    options: InteractionResumeOptions,
    ownerSessionId: string | null,
  ): Promise<Dict> {
    const event: Dict | null = isRecord(resume.event)
      ? { ...resume.event, control: this.loop.controlManager.payload() }
      : null
    if (event)
      await this.emitRuntime(event, {
        emit: options.emit ?? null,
        sessionId: ownerSessionId,
      })
    if (
      resume.executionDisposition === 'cancel' &&
      ownerSessionId &&
      resume.executionId
    ) {
      const interactionMeta = isRecord(resume.interaction.meta)
        ? resume.interaction.meta
        : {}
      const activeTurnId =
        String(
          options.turnId ??
            interactionMeta.control_turn_id ??
            resume.executionId,
        ).trim() || resume.executionId
      const changes = await this.loop.finalizeExecutionChanges({
        sessionId: ownerSessionId,
        executionId: resume.executionId,
        activeTurnId,
      })
      if (changes && (changes.filesChanged > 0 || changes.status === 'partial'))
        await this.emitRuntime(changes as unknown as Dict, {
          emit: options.emit ?? null,
          sessionId: ownerSessionId,
        })
    }
    if (event?.event === 'plan_approved' && isRecord(event.plan)) {
      const planId = String(event.plan.id ?? '').trim()
      const steps = Array.isArray(event.plan.steps) ? event.plan.steps : []
      for (const step of steps) {
        if (!isRecord(step) || String(step.status ?? '') !== 'active') continue
        await this.emitRuntime(
          { event: 'plan_step_update', plan_id: planId, step: { ...step } },
          { emit: options.emit ?? null, sessionId: ownerSessionId },
        )
      }
    }
    let result: Dict | null = null
    if (resume.resume === true) {
      const interactionId = String(resume.interaction.id ?? '')
      const explicitGoalId =
        this.loop.controlManager.goalIdForInteraction(interactionId)
      const sessionGoal = ownerSessionId
        ? await this.loop.goalStore.findActiveBySession(ownerSessionId)
        : null
      const goal = explicitGoalId
        ? await this.loop.goalStore.get(explicitGoalId)
        : sessionGoal
      if (
        goal?.runtime.phase === 'awaiting_user' &&
        goal.runtime.pendingInteractionId === interactionId
      ) {
        await this.loop.goalCoordinator.resumeAfterControl(
          goal.id,
          interactionId,
        )
        return {
          ...(resume as unknown as Dict),
          event: event ?? resume.event,
          result: null,
        }
      }
      const uiHidden = options.uiHidden ?? false
      try {
        result = (await this.mainline.submit({
          content: String(resume.message ?? ''),
          displayContent: uiHidden
            ? ''
            : (options.displayContent ?? String(resume.message ?? '')),
          clientMessageId: options.clientMessageId ?? null,
          turnId: options.turnId ?? null,
          executionId: resume.executionId ?? null,
          source: 'control',
          sessionId: ownerSessionId,
          uiHidden,
          memoryExtra: resume.executionId
            ? {
                execution_id: resume.executionId,
                execution_root_turn_id: resume.executionId,
              }
            : null,
          emit: options.emit ?? null,
        })) as unknown as Dict
      } finally {
        await this.loop.settleProfileInterviewResume(resume.interaction.id)
      }
    }
    return {
      ...(resume as unknown as Dict),
      event: event ?? resume.event,
      result,
    }
  }
}

function interactionAnswerChoice(
  interaction: unknown,
  questionId: string,
): string {
  if (!isRecord(interaction) || !isRecord(interaction.answers)) return ''
  const answer = interaction.answers[questionId]
  return isRecord(answer) ? String(answer.choice ?? '') : ''
}

function isRecord(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
