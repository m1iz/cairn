import type { Interaction } from '../control/models'
import type { PlanRecord } from '../plans/models'
import type { PlanStore } from '../plans/store'
import type { CheckpointWriteOptions } from '../sessions/checkpoint'
import type { ToolDefinition } from '../tools/base'
import type { ToolRegistry } from '../tools/registry'

type Message = Record<string, unknown>

export interface MemoryStoreLike {
  memoryDir?: string
  checkpointFile?: string
  versions?: { list(opts?: { limit?: number; target?: unknown }): unknown[] }
  writeCheckpoint(history: Message[], opts?: CheckpointWriteOptions): void
  clearCheckpoint(): void
  readCheckpoint(): Message[] | null
  appendHistory(
    role: string,
    content: string,
    opts?: { extra?: Record<string, unknown> | null },
  ): void
}

export interface AgentRunnerInterjectionHost {
  consume():
    Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>
  tombstonePartial(record: {
    turnId: string | null
    content: string
    reason: 'interjected' | 'cancelled' | 'model_failed'
  }): void | Promise<void>
}

export interface TokenTrackerLike {
  record(
    model: string,
    usage: Record<string, number>,
    opts: Record<string, unknown>,
  ): void
  shouldCompact(maxContext: number, threshold: number): boolean
  lastInputTokensValue?(): number
}

export interface CompactorLike {
  compactAfterTurn?(opts: {
    history: Message[]
    turnId: string | null
    currentTokens: number
    maxContext: number
    goalHint?: {
      readonly goalId: string
      readonly lastEventSeq: number
    } | null
  }): Promise<unknown> | unknown
  compactAsync?(history: Message[]): Promise<Message[]>
  compact?(history: Message[]): Message[]
}

export interface TodoStoreLike {
  todos: Array<Record<string, unknown>>
  revision?: number
}

/** The minimal Control surface required by a runner. */
export interface ControlManagerRunnerHost {
  planStore?: PlanStore
  latestExecutablePlan?(): PlanRecord | null
  requestPlanExecutionDecision?(input: {
    turnId: string
    executionId: string
  }): Interaction | null
  currentPlanExecutionPhase?(): {
    planId: string
    stepId: string
    phase:
      | 'implementing'
      | 'verifying'
      | 'repairing'
      | 'waiting_user'
      | 'completed'
      | 'cancelled'
  } | null
  pausePlanExecution?(input: {
    reason: 'continuation_rejected' | 'no_progress' | 'verification_required'
    turnId: string
    executionId?: string | null
    pausedAt: number
    evaluationCount: number
    totalIterations: number
    nextActions: string[]
  }): PlanRecord | null
  resumePlanExecution?(input: { turnId: string }): PlanRecord | null
  systemPrompt(): string
  toolDefinitions(registry: ToolRegistry): ToolDefinition[]
  assessPermission(
    name: string,
    args: Record<string, unknown>,
    registry: ToolRegistry | null,
    opts?: {
      sessionId?: string | null
      turnId?: string | null
      workspaceRoot?: string | null
      cwd?: string | null
      taskIntent?: string | null
      authorizationId?: string | null
    },
  ):
    | Promise<{
        allowed: boolean
        requiresApproval: boolean
        reason: string
        risk?: string
        rule?: string
        trace?: Array<{ rule: string; outcome: string; detail: string }>
        arguments?: Record<string, unknown> | null
        toolName?: string
      }>
    | {
        allowed: boolean
        requiresApproval: boolean
        reason: string
        risk?: string
        rule?: string
        trace?: Array<{ rule: string; outcome: string; detail: string }>
        arguments?: Record<string, unknown> | null
        toolName?: string
      }
  assessPermissionBatch?(
    calls: Array<{
      id: string
      name: string
      arguments: Record<string, unknown>
    }>,
    registry: ToolRegistry | null,
    opts?: {
      sessionId?: string | null
      turnId?: string | null
      workspaceRoot?: string | null
      cwd?: string | null
      taskIntent?: string | null
      authorizationId?: string | null
    },
  ): Promise<{
    allowed: boolean
    requiresApproval: boolean
    reason: string
    risk?: string
    rule?: string
    decisions: Array<{
      allowed: boolean
      requiresApproval: boolean
      reason: string
      risk?: string
      rule?: string
      trace?: Array<{ rule: string; outcome: string; detail: string }>
      arguments?: Record<string, unknown> | null
      toolName?: string
    }>
    operations: Array<{
      callId: string
      fingerprint: string
      decision: unknown
    }>
    authorizationId?: string | null
  }>
  permissionApprovalResult(
    decision: unknown,
    opts?: { parentCallId?: string | null; sessionId?: string | null },
  ): string
  permissionBatchApprovalResult?(
    decision: unknown,
    opts?: {
      parentCallId?: string | null
      sessionId?: string | null
      workspaceRoot?: string | null
      cwd?: string | null
    },
  ): string
  assessClarification(history: Message[]): {
    required: boolean
    reason: string
    questions: Array<Record<string, unknown>>
    categories: string[]
  }
  assessPlanDecision?(userMessage: string): unknown
  shouldEnforcePlanFinal(): boolean
  createAsk(opts: {
    questions: Array<Record<string, unknown>>
    context?: string
    meta?: Record<string, unknown> | null
  }): Interaction
  recordPlanDiscovery?(opts: Record<string, unknown>): unknown
  recordPlanStepToolOutput?(opts: Record<string, unknown>): unknown
  normalizePlanTodoUpdate?(
    todos: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>>
  migrateLegacyPlanTodoMirrors?(): void
  claimUnverifiedPlanSteps?(): {
    planId: string
    steps: Array<{ id: string; title: string }>
  } | null
  planMatchesCurrentScope?(record: PlanRecord): boolean
  planIndependentVerificationFollowup?(opts?: {
    dispatchAvailable?: boolean
  }): Record<string, unknown> | null
  recordIndependentVerificationToolResult?(opts: {
    toolCallId: string
    agentType: string
    output: string
  }): PlanRecord | null
  independentVerificationDispatchGuard?(agentType: string): string | null
  independentVerificationAskGuard?(): string | null
  markIndependentVerificationDelivered?(): PlanRecord | null
  planVerificationTarget?(command: string): Record<string, string> | null
  recordPlanVerificationResult?(opts: {
    planId: string
    stepId: string
    result: Record<string, unknown>
  }): PlanRecord | null
}
