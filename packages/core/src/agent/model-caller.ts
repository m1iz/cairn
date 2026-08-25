/**
 * ModelCaller。
 * 统一调用全局激活模型并记录重试元数据；不执行跨模型 fallback。
 */
import {
  parseJsonArgs,
  type ChatArgs,
  type LLMProvider,
  type LLMResponse,
  type ToolCallDelta,
  type ToolCallRequest,
} from '../providers/base'
import type { ModelPricing } from '../config/model-config'
import { type ProviderErrorKind } from '../providers/errors'
import {
  calculateUsageCost,
  stripModelBoundMessageState,
  usdToNanos,
} from '../model/execution-policy'
import { SamplingCoordinator } from '../sampling/coordinator'
import * as runtimeEvents from '../runtime/events'
import type { ModelCompletion, ModelMessage } from '../model/contracts'
import { ProviderModelPort } from '../model/provider-adapter'
import { ModelAttemptExecutor } from '../model/attempt-executor'
import {
  costBoundMaxTokens,
  createModelPolicyTurnState,
  fallbackEligible,
  providerFailureKind,
  type ModelCallPolicy,
  type ModelCallTarget,
  type ModelPolicyTurnState,
} from '../model/call-policy'

export {
  createModelPolicyTurnState,
  type ModelCallPolicy,
  type ModelCallTarget,
  type ModelPolicyTurnState,
} from '../model/call-policy'

export type StreamEmitter = (
  event: Record<string, unknown>,
) => void | Promise<void>

export interface ModelCallMeta {
  model: string
  provider: string | null
  modelEntryId: string
  routeReason: string
  routeEstimatedTokens: number | null
  estimatedInputTokens: number | null
  providerRetryCount: number
  providerErrorKind: string
  usedFallback: boolean
  fallbackReason: string
  costUsdNanos: number | null
  turnCostUsdNanos: number
  costCapUsdNanos: number | null
  costComplete: boolean
}

/** ModelCaller 依赖的 runner 表面。 */
export interface RunnerModelHost {
  provider: LLMProvider
  model: string
  providerName: string | null
  modelEntryId: string
  supportsToolCall: boolean
  routeReason: string
  routeEstimatedTokens: number | null
  maxTokens: number
  temperature: number
  reasoningEffort: string | null
  pricing?: ModelPricing | null
  usageType: string
  lastEstimatedInputTokens: number | null
  lastModelCall: ModelCallMeta
  modelPolicy?: ModelCallPolicy | null
  modelPolicyTurn?: ModelPolicyTurnState
}

export class ModelCaller {
  private readonly runner: RunnerModelHost
  private readonly sampling: SamplingCoordinator
  constructor(
    runner: RunnerModelHost,
    sampling: SamplingCoordinator = new SamplingCoordinator(),
  ) {
    this.runner = runner
    this.sampling = sampling
  }

  async ask(opts: {
    messages: ChatArgs['messages']
    tools: Array<Record<string, unknown>> | null
    emit: StreamEmitter | null
    signal?: AbortSignal | null
    onToolCallComplete?:
      ((call: ToolCallRequest) => void | Promise<void>) | null
  }): Promise<LLMResponse> {
    const runner = this.runner
    const primary = primaryTarget(runner)
    const policy = runner.modelPolicy ?? null
    const turn = runner.modelPolicyTurn ?? createModelPolicyTurnState()
    const current =
      policy?.fallback && turn.activeTarget === 'fallback'
        ? policy.fallback
        : primary
    try {
      return await this.askTarget({
        target: current,
        messages:
          current === primary
            ? opts.messages
            : (stripModelBoundMessageState(
                opts.messages as Array<Record<string, unknown>>,
              ) as ChatArgs['messages']),
        opts,
        policy,
        turn,
      })
    } catch (error) {
      const fallback = policy?.fallback ?? null
      if (
        current !== primary ||
        !fallback ||
        !fallbackEligible(error, policy!.triggerOn)
      )
        throw error
      turn.activeTarget = 'fallback'
      turn.usedFallback = true
      turn.fallbackReason = providerFailureKind(error)
      // A terminal provider path may have been billed without returning usage.
      turn.costComplete = false
      if (opts.emit)
        await opts.emit({
          event: 'model_route_fallback',
          from_model: primary.model,
          from_model_entry_id: primary.modelEntryId,
          to_model: fallback.model,
          to_model_entry_id: fallback.modelEntryId,
          reason: turn.fallbackReason,
          error_kind: turn.fallbackReason,
          usage_type: runner.usageType,
        })
      return await this.askTarget({
        target: fallback,
        messages: stripModelBoundMessageState(
          opts.messages as Array<Record<string, unknown>>,
        ) as ChatArgs['messages'],
        opts,
        policy,
        turn,
      })
    }
  }

  private async askTarget(input: {
    target: ModelCallTarget
    messages: ChatArgs['messages']
    opts: {
      messages: ChatArgs['messages']
      tools: Array<Record<string, unknown>> | null
      emit: StreamEmitter | null
      signal?: AbortSignal | null
      onToolCallComplete?:
        ((call: ToolCallRequest) => void | Promise<void>) | null
    }
    policy: ModelCallPolicy | null
    turn: ModelPolicyTurnState
  }): Promise<LLMResponse> {
    const { target, opts, policy, turn } = input
    const staged =
      policy?.fallback && opts.emit ? new StagedModelEvents() : null
    const streamEmit = staged
      ? async (event: Record<string, unknown>) => staged.push(event)
      : opts.emit
    const onDelta = async (delta: string): Promise<void> => {
      if (streamEmit) await streamEmit({ event: 'message_delta', delta })
    }
    const planDeltaThrottle = createPlanDeltaThrottle(
      streamEmit,
      PLAN_DELTA_INTERVAL_MS,
    )
    const maxTokens = costBoundMaxTokens({
      policy,
      turn,
      target,
      estimatedInputTokens:
        Math.max(0, Math.trunc(this.runner.lastEstimatedInputTokens ?? 0)) +
        conservativeToolDefinitionTokenBound(
          target.supportsToolCall ? opts.tools : null,
        ),
    })
    this.runner.lastModelCall = initialCallMeta(
      this.runner,
      target,
      policy,
      turn,
    )
    let result: Awaited<ReturnType<ModelCaller['callProviderWithRetries']>>
    try {
      result = await this.callProviderWithRetries({
        provider: target.provider,
        model: target.model,
        providerName: target.providerName,
        usageType: this.runner.usageType,
        maxTokens,
        temperature: target.temperature,
        reasoningEffort: target.reasoningEffort,
        messages: input.messages,
        tools: target.supportsToolCall ? opts.tools : null,
        emit: opts.emit,
        onDelta,
        onToolCallDelta: target.supportsToolCall
          ? planDeltaThrottle.onDelta
          : null,
        // With an explicit fallback, tool IDs remain provisional until the
        // selected model call reaches a successful terminal response.
        onToolCallComplete:
          target.supportsToolCall && !policy?.fallback
            ? (opts.onToolCallComplete ?? null)
            : null,
        signal: opts.signal ?? null,
      })
    } catch (error) {
      turn.costComplete = false
      throw error
    }
    await planDeltaThrottle.flush()
    const cost = calculateUsageCost(result.response.usage, target.pricing)
    if (cost.costUsdNanos !== null)
      turn.costUsedUsdNanos = safeNanosAdd(
        turn.costUsedUsdNanos,
        cost.costUsdNanos,
      )
    if (!cost.complete || result.retryCount > 0) turn.costComplete = false
    this.runner.lastModelCall = {
      ...initialCallMeta(this.runner, target, policy, turn),
      providerRetryCount: result.retryCount,
      providerErrorKind: result.errorKind,
      costUsdNanos: cost.costUsdNanos,
      turnCostUsdNanos: turn.costUsedUsdNanos,
      costComplete: turn.costComplete,
    }
    if (staged && opts.emit) await staged.flush(opts.emit)
    return target.supportsToolCall
      ? result.response
      : { ...result.response, toolCalls: [] }
  }

  private async callProviderWithRetries(opts: {
    provider: LLMProvider
    model: string
    providerName: string | null
    usageType: string
    maxTokens: number
    temperature: number
    reasoningEffort: string | null
    messages: ChatArgs['messages']
    tools: Array<Record<string, unknown>> | null
    emit: StreamEmitter | null
    onDelta: (delta: string) => Promise<void>
    onToolCallDelta?: ((delta: ToolCallDelta) => Promise<void>) | null
    onToolCallComplete?:
      ((call: ToolCallRequest) => void | Promise<void>) | null
    signal: AbortSignal | null
    onRetry?: (retryCount: number, errorKind: ProviderErrorKind) => void
  }): Promise<{
    response: LLMResponse
    retryCount: number
    errorKind: ProviderErrorKind | ''
  }> {
    const result = await new ModelAttemptExecutor(this.sampling).execute({
      request: {
        messages: opts.messages.map(toGatewayMessage),
        tools: opts.tools,
        model: opts.model,
        maxOutputTokens: opts.maxTokens,
        temperature: opts.temperature,
        reasoningEffort: opts.reasoningEffort,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      port: new ProviderModelPort(opts.provider),
      recoverRequest: (error) => opts.provider.recoverSamplingRequest(error),
      model: opts.model,
      provider: opts.providerName,
      usageType: opts.usageType,
      emit: opts.emit,
      stream:
        opts.emit || opts.onToolCallComplete
          ? {
              onContentDelta: opts.onDelta,
              onToolCallDelta: opts.onToolCallDelta ?? undefined,
              onToolCallComplete: opts.onToolCallComplete ?? undefined,
            }
          : undefined,
      onRetry: opts.onRetry,
    })
    return {
      response: fromGatewayCompletion(result.completion),
      retryCount: result.retryCount,
      errorKind: result.errorKind,
    }
  }
}

function toGatewayMessage(message: ChatArgs['messages'][number]): ModelMessage {
  const { role, content, ...attributes } = message
  return {
    role,
    ...(content === undefined ? {} : { content }),
    ...(Object.keys(attributes).length ? { attributes } : {}),
  }
}

function fromGatewayCompletion(completion: ModelCompletion): LLMResponse {
  return {
    content: completion.content,
    toolCalls: completion.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: structuredClone(call.arguments),
    })),
    finishReason: completion.finishReason,
    usage: { ...completion.usage },
    reasoningContent: completion.reasoningContent,
    thinkingBlocks: completion.thinkingBlocks
      ? completion.thinkingBlocks.map((block) => structuredClone(block))
      : null,
  }
}

function primaryTarget(runner: RunnerModelHost): ModelCallTarget {
  return {
    provider: runner.provider,
    model: runner.model,
    providerName: runner.providerName,
    modelEntryId: runner.modelEntryId,
    supportsToolCall: runner.supportsToolCall,
    maxTokens: runner.maxTokens,
    temperature: runner.temperature,
    reasoningEffort: runner.reasoningEffort,
    pricing: runner.pricing ?? null,
  }
}

function initialCallMeta(
  runner: RunnerModelHost,
  target: ModelCallTarget,
  policy: ModelCallPolicy | null,
  turn: ModelPolicyTurnState,
): ModelCallMeta {
  return {
    model: target.model,
    provider: target.providerName,
    modelEntryId: target.modelEntryId,
    routeReason: runner.routeReason,
    routeEstimatedTokens: runner.routeEstimatedTokens,
    estimatedInputTokens: runner.lastEstimatedInputTokens,
    providerRetryCount: 0,
    providerErrorKind: '',
    usedFallback: turn.usedFallback,
    fallbackReason: turn.fallbackReason,
    costUsdNanos: null,
    turnCostUsdNanos: turn.costUsedUsdNanos,
    costCapUsdNanos:
      policy?.maxUsdPerAgentTurn === null ||
      policy?.maxUsdPerAgentTurn === undefined
        ? null
        : usdToNanos(policy.maxUsdPerAgentTurn),
    costComplete: turn.costComplete,
  }
}

/**
 * Tool schemas are serialized into the provider request and therefore consume
 * input tokens even though the message estimator cannot see them. UTF-8 byte
 * length is a safe tokenizer-independent upper bound (one token cannot encode
 * less than one byte); the fixed per-tool allowance covers protocol framing.
 */
function conservativeToolDefinitionTokenBound(
  tools: Array<Record<string, unknown>> | null,
): number {
  if (!tools?.length) return 0
  return Buffer.byteLength(JSON.stringify(tools), 'utf8') + tools.length * 16
}

function safeNanosAdd(left: number, right: number): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum) || sum < 0)
    throw new Error('model cost ledger exceeds safe nano-USD range')
  return sum
}

const MAX_STAGED_MODEL_EVENTS = 20_000
const MAX_STAGED_MODEL_BYTES = 16 * 1024 * 1024

class StagedModelEvents {
  private readonly events: Record<string, unknown>[] = []
  private bytes = 0

  push(event: Record<string, unknown>): void {
    const cloned = structuredClone(event)
    this.bytes += Buffer.byteLength(JSON.stringify(cloned), 'utf8')
    if (
      this.events.length >= MAX_STAGED_MODEL_EVENTS ||
      this.bytes > MAX_STAGED_MODEL_BYTES
    )
      throw new Error('provisional model output exceeded staging limit')
    this.events.push(cloned)
  }

  async flush(emit: StreamEmitter): Promise<void> {
    for (const event of this.events) await emit(event)
    this.events.length = 0
    this.bytes = 0
  }
}

const PLAN_DELTA_INTERVAL_MS = 100

/**
 * plan_draft_delta 节流（B6）：每条 delta 都携带全量快照，窗口内只保留最新一条，
 * 流结束时 trailing flush 保证终态不丢。
 */
export function createPlanDeltaThrottle(
  emit: StreamEmitter | null,
  intervalMs = PLAN_DELTA_INTERVAL_MS,
): {
  onDelta: (delta: ToolCallDelta) => Promise<void>
  flush: () => Promise<void>
} {
  let lastEmitMs = 0
  let pending: Record<string, unknown> | null = null
  return {
    async onDelta(delta: ToolCallDelta): Promise<void> {
      if (!emit) return
      const event = planDraftDeltaFromToolDelta(delta)
      if (!event) return
      const now = Date.now()
      if (now - lastEmitMs >= intervalMs) {
        lastEmitMs = now
        pending = null
        await emit(event)
        return
      }
      pending = event
    },
    async flush(): Promise<void> {
      if (pending === null || !emit) return
      const event = pending
      pending = null
      await emit(event)
    },
  }
}

function planDraftDeltaFromToolDelta(
  delta: ToolCallDelta,
): Record<string, unknown> | null {
  if (delta.name !== 'propose_plan') return null
  const args = parseJsonArgs(delta.argumentsText)
  const title = textField(args, 'title')
  const summary = textField(args, 'summary')
  const planMarkdown =
    textField(args, 'plan_markdown') || textField(args, 'planMarkdown')
  if (!title && !summary && !planMarkdown) return null
  const streamId = delta.id || `call_${delta.index}`
  const interaction: Record<string, unknown> = {
    id: `provisional-plan-${streamId}`,
    kind: 'plan',
    status: 'waiting',
    parent_call_id: streamId,
    title,
    summary,
    plan_markdown: planMarkdown,
    assumptions: stringArrayField(args, 'assumptions'),
    risk_level:
      textField(args, 'risk_level') || textField(args, 'riskLevel') || 'medium',
    meta: { plan_stream_id: streamId, provisional: true },
  }
  return runtimeEvents.planDraftDelta({ toolCallId: streamId, interaction })
}

function textField(value: Record<string, unknown>, key: string): string {
  const raw = value[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

function stringArrayField(
  value: Record<string, unknown>,
  key: string,
): string[] {
  const raw = value[key]
  if (!Array.isArray(raw)) return []
  return raw.map((item) => String(item || '').trim()).filter(Boolean)
}
