/** 单模型路由：所有 use case 共享当前激活条目，路由只记录用途，不再选型或 fallback。 */
import { resolve } from 'node:path'
import {
  activeEntry,
  findEntry,
  type ModelConfig,
  type ModelEntry,
  type ModelFallbackTrigger,
  type ModelPricing,
} from '../config/model-config'
import { createProvider } from '../providers/factory'
import {
  findByName,
  type HostedWebSearchCapability,
  type ProviderProtocol,
  type ProviderSpec,
} from '../providers/registry'
import { type GenerationSettings, type LLMProvider } from '../providers/base'
import { modelAvailability, type ModelAvailability } from './availability'
import { resolveModelProfile, type ResolvedModelProfile } from './profile'

export type ModelRole = 'main' | 'secondary'

export interface ProviderSnapshot {
  provider: LLMProvider
  providerName: string
  providerLabel: string
  model: string
  apiBase: string | null
  generation: GenerationSettings
  /** Compatibility-optional for synthetic test snapshots; real snapshots always set it. */
  profile?: ResolvedModelProfile
  protocol?: ProviderProtocol
  contextWindowTokens: number
  config: Record<string, unknown>
  supportsVision: boolean
  hostedWebSearch?: HostedWebSearchCapability | null
  pricing?: ModelPricing
  modelEntryId: string
  routeReason: string
}

export interface ModelRoute {
  snapshot: ProviderSnapshot
  executionPolicy?: {
    fallback: ProviderSnapshot | null
    triggerOn: ModelFallbackTrigger[]
    maxUsdPerAgentTurn: number | null
  }
  useCase: string
  reason: string
  estimatedTokens: number | null
}

export class ModelRouter {
  readonly root: string
  readonly availability: ModelAvailability
  readonly active: ProviderSnapshot
  readonly executionPolicy: ModelRoute['executionPolicy']
  private readonly routeCounts = new Map<string, number>()

  constructor(root: string, config: ModelConfig) {
    this.root = resolve(root)
    this.availability = modelAvailability(config)
    this.active = activeEntry(config)
      ? buildProviderSnapshot(config)
      : bootstrapProviderSnapshot()
    this.executionPolicy = activeEntry(config)
      ? buildExecutionPolicy(config)
      : undefined
  }

  route(
    useCase: string,
    agentType?: string | null,
    task?: string | null,
  ): ModelRoute {
    void agentType
    const key = String(useCase || 'main_agent')
    this.routeCounts.set(key, (this.routeCounts.get(key) ?? 0) + 1)
    return this.activeRoute(key, task)
  }

  routeForRole(
    useCase: string,
    _role: ModelRole,
    task?: string | null,
  ): ModelRoute {
    return this.route(useCase, null, task)
  }

  private activeRoute(useCase: string, task?: string | null): ModelRoute {
    return {
      snapshot: { ...this.active, routeReason: useCase },
      ...(this.executionPolicy
        ? {
            executionPolicy: {
              ...this.executionPolicy,
              fallback: this.executionPolicy.fallback
                ? {
                    ...this.executionPolicy.fallback,
                    routeReason: `${useCase}:explicit_fallback`,
                  }
                : null,
              triggerOn: [...this.executionPolicy.triggerOn],
            },
          }
        : {}),
      useCase,
      reason: useCase,
      estimatedTokens: task ? roughTokenEstimate(task) : null,
    }
  }

  payload(): Record<string, unknown> {
    return {
      activeModelId: this.availability.usable ? this.active.modelEntryId : null,
      activeModel: this.availability.usable ? this.active.model : null,
      routeCounts: Object.fromEntries(this.routeCounts),
    }
  }
}

export function roughTokenEstimate(text: string): number {
  return Math.max(1, Math.floor((text || '').length / 3))
}

// ── snapshot 装配（对齐 `build_provider_snapshot`）──

export interface SnapshotArgs {
  entryId?: string | null
}

export function buildProviderSnapshot(
  config: ModelConfig,
  args: SnapshotArgs = {},
): ProviderSnapshot {
  const entryId = args.entryId ?? null
  const entry = resolveActiveEntry(config, entryId)
  const spec = findByName(entry.provider) ?? fallbackSpec(entry.provider)
  const modelId = entry.modelId
  const apiKey = entry.apiKey
  const apiBase = entry.apiBase
  const extraHeaders = entry.requestOptions?.extraHeaders ?? null
  const extraBody = entry.requestOptions?.extraBody ?? null

  const protocol = snapshotProtocol(entry, spec)
  const resolvedApiBase = snapshotApiBase(apiBase, spec, protocol)
  const profile = resolveModelProfile({
    provider: entry.provider,
    protocol,
    modelId,
    capabilityOverrides: entry.capabilityOverrides,
    contextWindowTokens: entry.contextWindowTokens,
    maxTokens: entry.maxTokens,
  })
  const generation: GenerationSettings = {
    maxTokens: profile.maxTokens,
    temperature: entry.requestOptions?.temperature ?? 0.1,
    reasoningEffort: entry.reasoningEffort,
  }

  const provider = createProvider({
    protocol,
    profile,
    spec,
    apiKey,
    apiBase: resolvedApiBase,
    defaultModel: modelId,
    extraHeaders,
    extraBody,
  })
  provider.generation = generation

  const contextWindowTokens = profile.contextWindowTokens

  return {
    provider,
    providerName: spec.name,
    providerLabel: spec.displayName,
    model: modelId,
    apiBase: resolvedApiBase,
    generation,
    profile,
    protocol,
    contextWindowTokens,
    config: structuredClone(config) as unknown as Record<string, unknown>,
    supportsVision: profile.vision,
    hostedWebSearch: spec.hostedWebSearch,
    ...(entry.pricing ? { pricing: structuredClone(entry.pricing) } : {}),
    modelEntryId: entry.entryId,
    routeReason: 'active_model',
  }
}

/**
 * Session bindings need a provider object before first-run model setup. This
 * placeholder is never considered available and normal turn admission rejects
 * it before provider I/O.
 */
function bootstrapProviderSnapshot(): ProviderSnapshot {
  const spec = findByName('deepseek')
  if (!spec) throw new Error('deepseek provider missing from registry')
  const protocol: ProviderProtocol = 'openai'
  const model = 'deepseek-chat'
  const apiBase = spec.apiBases[protocol]
  if (!apiBase) throw new Error('deepseek provider API base is missing')
  const profile = resolveModelProfile({
    provider: spec.name,
    protocol,
    modelId: model,
    contextWindowTokens: 128_000,
    maxTokens: 8_192,
  })
  const generation: GenerationSettings = {
    maxTokens: profile.maxTokens,
    temperature: 0.1,
    reasoningEffort: null,
  }
  const provider = createProvider({
    protocol,
    profile,
    spec,
    apiKey: null,
    apiBase,
    defaultModel: model,
    extraHeaders: null,
    extraBody: null,
  })
  provider.generation = generation
  return {
    provider,
    providerName: spec.name,
    providerLabel: spec.displayName,
    model,
    apiBase,
    generation,
    profile,
    protocol,
    contextWindowTokens: profile.contextWindowTokens,
    config: {},
    supportsVision: profile.vision,
    hostedWebSearch: spec.hostedWebSearch,
    modelEntryId: 'unconfigured',
    routeReason: 'bootstrap_unconfigured',
  }
}

function buildExecutionPolicy(
  config: ModelConfig,
): ModelRoute['executionPolicy'] {
  const policy = config.policy
  const hasFallback =
    policy.fallback.enabled && Boolean(policy.fallback.entryId)
  const hasCostCap = policy.cost.maxUsdPerAgentTurn !== null
  if (!hasFallback && !hasCostCap) return undefined
  return {
    fallback:
      hasFallback && policy.fallback.entryId
        ? buildProviderSnapshot(config, {
            entryId: policy.fallback.entryId,
          })
        : null,
    triggerOn: [...policy.fallback.triggerOn],
    maxUsdPerAgentTurn: policy.cost.maxUsdPerAgentTurn,
  }
}

function snapshotProtocol(
  entry: ModelEntry,
  spec: ProviderSpec,
): ProviderProtocol {
  const protocol = entry.protocol ?? spec.defaultProtocol
  if (!protocol)
    throw new Error(`Provider ${spec.name} requires an explicit protocol`)
  if (!spec.protocols.includes(protocol))
    throw new Error(
      `Provider ${spec.name} does not support ${protocol} protocol`,
    )
  return protocol
}

function snapshotApiBase(
  explicit: string | null,
  spec: ProviderSpec,
  protocol: ProviderProtocol,
): string {
  const apiBase = explicit || spec.apiBases[protocol]
  if (!apiBase)
    throw new Error(
      `Provider ${spec.name} requires an API base for ${protocol} protocol`,
    )
  return apiBase
}

function resolveActiveEntry(
  config: ModelConfig,
  entryId: string | null,
): ModelEntry {
  const entry = entryId ? findEntry(config, entryId) : activeEntry(config)
  if (!entry)
    throw new Error(
      entryId
        ? `Model entry not found: ${entryId}`
        : 'No active model entry is configured',
    )
  return entry
}

function fallbackSpec(_providerName: string): ProviderSpec {
  const custom = findByName('custom')
  if (!custom) throw new Error('custom provider missing from registry')
  return custom
}
