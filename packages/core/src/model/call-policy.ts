import type { ModelFallbackTrigger, ModelPricing } from '../config/model-config'
import { ModelCostCapExceededError, ModelProviderError } from '../errors'
import { planCostBound, usdToNanos } from './execution-policy'
import type { LLMProvider } from '../providers/base'

export interface ModelCallTarget {
  provider: LLMProvider
  model: string
  providerName: string | null
  modelEntryId: string
  supportsToolCall: boolean
  maxTokens: number
  temperature: number
  reasoningEffort: string | null
  pricing: ModelPricing | null
}

export interface ModelCallPolicy {
  fallback: ModelCallTarget | null
  triggerOn: ModelFallbackTrigger[]
  maxUsdPerAgentTurn: number | null
}

export interface ModelPolicyTurnState {
  activeTarget: 'primary' | 'fallback'
  costUsedUsdNanos: number
  costComplete: boolean
  usedFallback: boolean
  fallbackReason: string
}

export function createModelPolicyTurnState(): ModelPolicyTurnState {
  return {
    activeTarget: 'primary',
    costUsedUsdNanos: 0,
    costComplete: true,
    usedFallback: false,
    fallbackReason: '',
  }
}

export function costBoundMaxTokens(input: {
  policy: ModelCallPolicy | null
  turn: ModelPolicyTurnState
  target: ModelCallTarget
  estimatedInputTokens: number | null
}): number {
  const cap = input.policy?.maxUsdPerAgentTurn
  if (cap === null || cap === undefined) return input.target.maxTokens
  if (!input.target.pricing)
    throw new ModelCostCapExceededError(
      `模型 ${input.target.modelEntryId} 缺少完整 pricing，无法执行成本上限。`,
    )
  const remainingUsdNanos = Math.max(
    0,
    usdToNanos(cap) - input.turn.costUsedUsdNanos,
  )
  const bound = planCostBound({
    remainingUsdNanos,
    estimatedInputTokens: Math.max(
      0,
      Math.trunc(input.estimatedInputTokens ?? 0),
    ),
    requestedMaxTokens: input.target.maxTokens,
    pricing: input.target.pricing,
  })
  if (bound.maxTokens < 1)
    throw new ModelCostCapExceededError(
      `本轮剩余成本不足以调用模型 ${input.target.modelEntryId}。`,
    )
  return bound.maxTokens
}

export function fallbackEligible(
  error: unknown,
  triggerOn: readonly ModelFallbackTrigger[],
): boolean {
  if (!(error instanceof ModelProviderError)) return false
  if (error.providerErrorKind === 'rate_limit')
    return triggerOn.includes('rate_limit')
  if (error.providerErrorKind === 'transient')
    return triggerOn.includes('transient')
  return false
}

export function providerFailureKind(error: unknown): string {
  return error instanceof ModelProviderError
    ? error.providerErrorKind
    : 'unknown'
}
