import type {
  GoalEvidenceLedger,
  GoalEvidenceReceipt,
  GoalObservation,
  GoalObservationRecorder,
  RecordToolResultInput,
} from '../goals/evidence'
import type { ToolResultObj } from '../tools/base'
import type { ToolRegistry } from '../tools/registry'

export interface RunnerGoalRecordingHost {
  captureExpectedGoalId?(sessionId: string): Promise<string | null>
  recordToolResult(
    input: RecordToolResultInput,
  ): Promise<GoalObservation | null>
  recordPlanVerificationReceipt?(
    input: RunnerPlanVerificationReceiptInput,
  ): Promise<GoalEvidenceReceipt | null>
}

export interface RunnerPlanVerificationReceiptInput {
  readonly observation: GoalObservation
  readonly target: Readonly<Record<string, string>>
  readonly result: Readonly<Record<string, unknown>>
}

export interface RunnerPlanVerificationUpdate {
  readonly target: Readonly<Record<string, string>>
  readonly result: Readonly<Record<string, unknown>>
}

export interface RunnerFinalToolResultInput {
  readonly expectedGoalId?: string | null
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments?: Readonly<Record<string, unknown>>
  readonly executed: boolean
  readonly result: ToolResultObj
  readonly runtimeEventSeq?: number | null
  readonly artifactRefs?: readonly string[]
}

export interface RunnerGoalRecordingContext {
  readonly expectedGoalId?: string | null
  readonly taskId: string
  readonly agentId: string
  readonly turnId: string
}

/** Core binds subagent identity; model arguments can never supply it. */
export function bindRunnerGoalRecordingContext(
  recorder: RunnerGoalRecordingHost,
  context: RunnerGoalRecordingContext,
): RunnerGoalRecordingHost {
  return {
    captureExpectedGoalId: async (sessionId) =>
      context.expectedGoalId !== undefined
        ? context.expectedGoalId
        : ((await recorder.captureExpectedGoalId?.(sessionId)) ?? null),
    recordToolResult: (input) =>
      recorder.recordToolResult({
        ...input,
        expectedGoalId: context.expectedGoalId ?? input.expectedGoalId,
        taskId: context.taskId,
        agentId: context.agentId,
        turnId: context.turnId,
      }),
    ...(recorder.recordPlanVerificationReceipt
      ? {
          recordPlanVerificationReceipt: (
            input: RunnerPlanVerificationReceiptInput,
          ) => recorder.recordPlanVerificationReceipt!(input),
        }
      : {}),
  }
}

/** Core-owned adapter that can turn a recorded Plan verification into a receipt. */
export class RunnerGoalRecordingService implements RunnerGoalRecordingHost {
  constructor(
    private readonly observations: GoalObservationRecorder,
    private readonly evidence: GoalEvidenceLedger,
  ) {}

  async captureExpectedGoalId(sessionId: string): Promise<string | null> {
    return await this.observations.captureExpectedGoalId(sessionId)
  }

  async recordToolResult(
    input: RecordToolResultInput,
  ): Promise<GoalObservation | null> {
    return await this.observations.recordToolResult(input)
  }

  async recordPlanVerificationReceipt(
    input: RunnerPlanVerificationReceiptInput,
  ): Promise<GoalEvidenceReceipt | null> {
    if (
      input.observation.toolName !== 'run_command' ||
      !input.observation.eligible ||
      input.observation.isError ||
      input.result.passed !== true
    )
      return null
    const planId = requiredSourcePart(input.target.plan_id, 'plan')
    const stepId = requiredSourcePart(input.target.step_id, 'step')
    const requirementId = requiredSourcePart(
      input.target.requirement_id ?? 'command',
      'requirement',
    )
    const approvedInputHash = requiredSourcePart(
      input.target.approved_input_hash,
      'approved input hash',
    )
    return await this.evidence.issuePlanVerificationReceipt(
      input.observation.goalId,
      {
        planId,
        stepId,
        requirementId,
        toolCallId: input.observation.toolCallId,
        sourceObservationId: input.observation.id,
        approvedInputHash,
      },
    )
  }
}

/** Resolve evidence policy from Core's registry; no model/renderer field is accepted. */
export async function recordRunnerGoalToolResult(
  recorder: RunnerGoalRecordingHost | null,
  registry: ToolRegistry,
  input: RunnerFinalToolResultInput,
): Promise<GoalObservation | null> {
  if (!recorder || !input.executed) return null
  const tool = registry.get(input.toolName)
  if (!tool) return null
  return await recorder.recordToolResult({
    ...input,
    evidencePolicy: tool.evidencePolicy,
  })
}

export async function recordRunnerPlanVerificationReceipt(
  recorder: RunnerGoalRecordingHost | null,
  observation: GoalObservation | null,
  update: RunnerPlanVerificationUpdate | null,
): Promise<GoalEvidenceReceipt | null> {
  if (
    !recorder?.recordPlanVerificationReceipt ||
    observation === null ||
    update === null
  )
    return null
  return await recorder.recordPlanVerificationReceipt({
    observation,
    target: update.target,
    result: update.result,
  })
}

function requiredSourcePart(value: unknown, label: string): string {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`Plan verification ${label} ID is required.`)
  return text
}
