import { z } from 'zod'
import {
  HOOK_EVENT_NAMES,
  type HookAgentHandlerV2,
  type HookCommandHandlerV2,
  type HookDefinition,
  type HookDiagnostic,
  type HookEventName,
  type HookGroup,
  type HookHandler,
  type HookHandlerV2,
  type HookHttpHandlerV2,
  type HookPolicy,
  type HookPromptHandlerV2,
  type HookSource,
  type HookSourceKind,
  type HooksConfig,
  type HooksConfigV2,
  type ParseHooksConfigResult,
  type ParseHooksConfigV2Result,
} from './models'

const EVENT_NAME_SET = new Set<string>(HOOK_EVENT_NAMES)
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000
const DEFAULT_HTTP_TIMEOUT_MS = 10_000

const V2_DEFAULT_POLICY: HookPolicy = {
  maxConcurrency: 4,
  maxContextBytes: 8_192,
  command: {
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 60_000,
    maxOutputBytes: 65_536,
    allowShell: false,
    allowedEnv: [],
  },
  http: {
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 60_000,
    maxResponseBytes: 1_048_576,
    allowedUrlPatterns: [],
    allowedEnv: [],
    allowLoopback: false,
    allowPrivateNetworks: false,
  },
  prompt: {
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 60_000,
  },
  agent: {
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 120_000,
    maxTurns: 12,
  },
}

const nonEmptyTextSchema = z.string().trim().min(1)
const stringListSchema = z.array(nonEmptyTextSchema).default([])
const stringMapSchema = z.record(z.string(), z.string()).default({})
const handlerBaseShape = {
  id: nonEmptyTextSchema,
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().default(''),
  once: z.boolean().default(false),
}

const commandHandlerV2Schema = z
  .object({
    ...handlerBaseShape,
    type: z.literal('command'),
    command: nonEmptyTextSchema,
    args: stringListSchema,
    shell: z.enum(['none', 'bash', 'powershell']).default('none'),
    allowedEnv: stringListSchema,
    async: z.boolean().default(false),
    asyncRewake: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.shell !== 'none' && value.args.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['args'],
        message: 'args must be empty when shell is enabled',
      })
    }
  })
  .transform((value): HookCommandHandlerV2 => ({
    ...value,
    timeoutMs: value.timeoutMs ?? V2_DEFAULT_POLICY.command.defaultTimeoutMs,
  }))

const httpHandlerV2Schema = z
  .object({
    ...handlerBaseShape,
    type: z.literal('http'),
    url: z.url(),
    headers: stringMapSchema,
    allowedEnv: stringListSchema,
  })
  .strict()
  .transform((value): HookHttpHandlerV2 => ({
    ...value,
    timeoutMs: value.timeoutMs ?? V2_DEFAULT_POLICY.http.defaultTimeoutMs,
  }))

const promptHandlerV2Schema = z
  .object({
    ...handlerBaseShape,
    type: z.literal('prompt'),
    prompt: nonEmptyTextSchema,
    modelRole: z.enum(['secondary', 'main']).default('secondary'),
  })
  .strict()
  .transform((value): HookPromptHandlerV2 => ({
    ...value,
    timeoutMs: value.timeoutMs ?? V2_DEFAULT_POLICY.prompt.defaultTimeoutMs,
  }))

const agentHandlerV2Schema = z
  .object({
    ...handlerBaseShape,
    type: z.literal('agent'),
    prompt: nonEmptyTextSchema,
    modelRole: z.enum(['secondary', 'main']).default('secondary'),
    maxTurns: z.number().int().min(1).max(12).default(12),
  })
  .strict()
  .transform((value): HookAgentHandlerV2 => ({
    ...value,
    timeoutMs: value.timeoutMs ?? V2_DEFAULT_POLICY.agent.defaultTimeoutMs,
  }))

const handlerV2Schema = z.union([
  commandHandlerV2Schema,
  httpHandlerV2Schema,
  promptHandlerV2Schema,
  agentHandlerV2Schema,
])

const hookGroupV2Schema = z
  .object({
    id: nonEmptyTextSchema,
    enabled: z.boolean().default(true),
    matcher: z.string().trim().default('*'),
    if: z.string().trim().default(''),
    failureMode: z.enum(['open', 'closed']).default('open'),
    handlers: z.array(handlerV2Schema).min(1),
  })
  .strict()

const partialPolicySchema = z
  .object({
    maxConcurrency: z.number().int().min(1).max(16).optional(),
    maxContextBytes: z.number().int().min(1).max(1_048_576).optional(),
    command: z
      .object({
        defaultTimeoutMs: z.number().int().positive().optional(),
        maxTimeoutMs: z.number().int().positive().optional(),
        maxOutputBytes: z.number().int().positive().optional(),
        allowShell: z.boolean().optional(),
        allowedEnv: z.array(nonEmptyTextSchema).optional(),
      })
      .strict()
      .optional(),
    http: z
      .object({
        defaultTimeoutMs: z.number().int().positive().optional(),
        maxTimeoutMs: z.number().int().positive().optional(),
        maxResponseBytes: z.number().int().positive().optional(),
        allowedUrlPatterns: z.array(nonEmptyTextSchema).optional(),
        allowedEnv: z.array(nonEmptyTextSchema).optional(),
        allowLoopback: z.boolean().optional(),
        allowPrivateNetworks: z.boolean().optional(),
      })
      .strict()
      .optional(),
    prompt: z
      .object({
        defaultTimeoutMs: z.number().int().positive().optional(),
        maxTimeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    agent: z
      .object({
        defaultTimeoutMs: z.number().int().positive().optional(),
        maxTimeoutMs: z.number().int().positive().optional(),
        maxTurns: z.number().int().min(1).max(12).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const outputMessageShape = {
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
}
const outputReasonShape = {
  ...outputMessageShape,
  reason: z.string().optional(),
}
const outputDecisionShape = {
  ...outputReasonShape,
  decision: z.enum(['deny', 'ask', 'allow', 'passthrough']).optional(),
}
const recordSchema = z.record(z.string(), z.unknown())
const observeOutputSchema = z.object(outputMessageShape).strict()
const contextOutputSchema = z
  .object({ ...outputReasonShape, additionalContext: z.string().optional() })
  .strict()
const transformInputOutputSchema = z
  .object({
    ...outputDecisionShape,
    additionalContext: z.string().optional(),
    updatedInput: recordSchema.optional(),
  })
  .strict()
const continueOutputSchema = z
  .object({
    ...outputDecisionShape,
    continue: z.boolean().optional(),
    stopReason: z.string().optional(),
    additionalContext: z.string().optional(),
  })
  .strict()

const HOOK_OUTPUT_SCHEMAS = {
  SessionStart: contextOutputSchema,
  SessionEnd: observeOutputSchema,
  UserPromptSubmit: transformInputOutputSchema,
  PreToolUse: transformInputOutputSchema,
  PostToolUse: z
    .object({
      ...outputReasonShape,
      additionalContext: z.string().optional(),
      updatedToolOutput: z.unknown().optional(),
    })
    .strict(),
  PostToolUseFailure: contextOutputSchema,
  PermissionRequest: transformInputOutputSchema,
  PermissionDenied: contextOutputSchema,
  Stop: continueOutputSchema,
  StopFailure: observeOutputSchema,
  SubagentStart: contextOutputSchema,
  SubagentStop: continueOutputSchema,
  PreCompact: z
    .object({
      ...outputDecisionShape,
      compactInstructions: z.string().optional(),
    })
    .strict(),
  PostCompact: observeOutputSchema,
  ConfigChange: z.object(outputDecisionShape).strict(),
  TaskCreated: z
    .object({
      ...outputDecisionShape,
      additionalContext: z.string().optional(),
    })
    .strict(),
  TaskCompleted: z
    .object({
      ...outputDecisionShape,
      additionalContext: z.string().optional(),
    })
    .strict(),
  TeammateIdle: continueOutputSchema,
} as const satisfies Record<HookEventName, z.ZodType>

export function defaultHooksConfig(): HooksConfig {
  return {
    version: 1,
    enabled: true,
    projectHooks: { enabled: false },
    hooks: {},
  }
}

export function defaultHooksConfigV2(): HooksConfigV2 {
  return {
    version: 2,
    enabled: true,
    projectHooks: { enabled: false },
    policy: clonePolicy(V2_DEFAULT_POLICY),
    hooks: {},
  }
}

export function parseHooksConfigV2(
  raw: unknown,
  opts: { sourceKind?: HookSourceKind | string } = {},
): ParseHooksConfigV2Result {
  const data = objectOrNull(raw)
  if (!data) return { config: defaultHooksConfigV2(), diagnostics: [] }
  const sourceKind = String(opts.sourceKind ?? 'global')
  return isV1Config(data)
    ? parseV1AsV2(data, sourceKind)
    : parseNativeV2(data, sourceKind)
}

export function serializeHooksConfigV2(
  config: HooksConfigV2,
): Record<string, unknown> {
  const hooks: Record<string, HookGroup[]> = {}
  for (const eventName of HOOK_EVENT_NAMES) {
    const groups = config.hooks[eventName]
    if (groups?.length) hooks[eventName] = groups.map(cloneGroup)
  }
  return {
    version: 2,
    enabled: config.enabled,
    projectHooks: { enabled: config.projectHooks.enabled },
    policy: clonePolicy(config.policy),
    hooks,
  }
}

export function parseHookOutput(
  eventName: string,
  raw: unknown,
): { output: Record<string, unknown> | null; diagnostics: HookDiagnostic[] } {
  if (!isHookEventName(eventName)) {
    return {
      output: null,
      diagnostics: [
        {
          code: 'invalid_event',
          path: 'hook_event_name',
          message: `Unsupported hook event: ${eventName}`,
        },
      ],
    }
  }
  const parsed = HOOK_OUTPUT_SCHEMAS[eventName].safeParse(raw)
  if (!parsed.success) {
    return {
      output: null,
      diagnostics: parsed.error.issues.map((issue) => ({
        code: 'invalid_hook_output',
        path: issue.path.join('.'),
        message: issue.message,
      })),
    }
  }
  return { output: parsed.data, diagnostics: [] }
}

export function parseHooksConfig(
  raw: unknown,
  opts: { source?: HookSource | null } = {},
): ParseHooksConfigResult {
  const diagnostics: HookDiagnostic[] = []
  const data = objectOrNull(raw)
  if (!data) return { config: defaultHooksConfig(), diagnostics }

  const config: HooksConfig = {
    version: 1,
    enabled: data.enabled === undefined ? true : Boolean(data.enabled),
    projectHooks: {
      enabled: Boolean(
        objectOrNull(data.projectHooks)?.enabled ??
        objectOrNull(data.project_hooks)?.enabled ??
        false,
      ),
    },
    hooks: {},
  }

  const hooks = objectOrNull(data.hooks)
  if (!hooks) return { config, diagnostics }
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!isHookEventName(eventName)) {
      diagnostics.push({
        code: 'invalid_event',
        path: `hooks.${eventName}`,
        message: `Unsupported hook event: ${eventName}`,
      })
      continue
    }
    if (!Array.isArray(entries)) {
      diagnostics.push({
        code: 'invalid_hooks_list',
        path: `hooks.${eventName}`,
        message: 'Hook event value must be an array',
      })
      continue
    }
    const normalized: HookDefinition[] = []
    for (let index = 0; index < entries.length; index++) {
      const entry = objectOrNull(entries[index])
      if (!entry) {
        diagnostics.push({
          code: 'invalid_hook',
          path: `hooks.${eventName}.${index}`,
          message: 'Hook entry must be an object',
        })
        continue
      }
      const handler = parseHandler(entry.handler)
      if (!handler) {
        diagnostics.push({
          code: 'invalid_handler',
          path: `hooks.${eventName}.${index}.handler`,
          message: 'Hook handler must be command or http',
        })
        continue
      }
      normalized.push({
        id: nonEmptyString(entry.id) ?? `${eventName}-${index + 1}`,
        eventName,
        enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
        matcher: nonEmptyString(entry.matcher) ?? '*',
        condition:
          nonEmptyString(entry.if) ?? nonEmptyString(entry.condition) ?? '',
        handler,
        source: opts.source ?? null,
      })
    }
    if (normalized.length > 0) config.hooks[eventName] = normalized
  }
  return { config, diagnostics }
}

function parseNativeV2(
  data: Record<string, unknown>,
  sourceKind: string,
): ParseHooksConfigV2Result {
  const diagnostics: HookDiagnostic[] = []
  const config = defaultHooksConfigV2()
  config.enabled = data.enabled === undefined ? true : Boolean(data.enabled)
  config.projectHooks.enabled = Boolean(
    objectOrNull(data.projectHooks)?.enabled ?? false,
  )
  config.policy = parseV2Policy(data.policy, sourceKind, diagnostics)
  config.hooks = parseV2Groups(data.hooks, diagnostics)
  return { config, diagnostics }
}

function parseV1AsV2(
  data: Record<string, unknown>,
  sourceKind: string,
): ParseHooksConfigV2Result {
  const diagnostics: HookDiagnostic[] = []
  const config = defaultHooksConfigV2()
  config.enabled = data.enabled === undefined ? true : Boolean(data.enabled)
  config.projectHooks.enabled = Boolean(
    objectOrNull(data.projectHooks)?.enabled ??
    objectOrNull(data.project_hooks)?.enabled ??
    false,
  )
  config.policy = parseV2Policy(data.policy, sourceKind, diagnostics)
  const hooks = objectOrNull(data.hooks)
  if (!hooks) return { config, diagnostics }

  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!isHookEventName(eventName)) {
      diagnostics.push({
        code: 'invalid_event',
        path: `hooks.${eventName}`,
        message: `Unsupported hook event: ${eventName}`,
      })
      continue
    }
    if (!Array.isArray(entries)) {
      diagnostics.push({
        code: 'invalid_hooks_list',
        path: `hooks.${eventName}`,
        message: 'Hook event value must be an array',
      })
      continue
    }
    const groups: HookGroup[] = []
    const seenGroups = new Set<string>()
    for (let index = 0; index < entries.length; index++) {
      const entry = objectOrNull(entries[index])
      if (!entry) {
        diagnostics.push({
          code: 'invalid_hook',
          path: `hooks.${eventName}.${index}`,
          message: 'Hook entry must be an object',
        })
        continue
      }
      const groupId = nonEmptyString(entry.id) ?? `${eventName}-${index + 1}`
      if (seenGroups.has(groupId)) {
        diagnostics.push({
          code: 'duplicate_group_id',
          path: `hooks.${eventName}.${index}.id`,
          message: `Duplicate hook group id: ${groupId}`,
        })
        continue
      }
      const legacyHandler = objectOrNull(entry.handler)
      if (!legacyHandler) {
        diagnostics.push({
          code: 'invalid_handler',
          path: `hooks.${eventName}.${index}.handler`,
          message: 'Hook handler must be an object',
        })
        continue
      }
      const handler = parseLegacyHandlerV2(
        groupId,
        legacyHandler,
        `hooks.${eventName}.${index}.handler`,
        diagnostics,
      )
      if (!handler) continue
      seenGroups.add(groupId)
      groups.push({
        id: groupId,
        enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
        matcher:
          typeof entry.matcher === 'string' ? entry.matcher.trim() || '*' : '*',
        if: nonEmptyString(entry.if) ?? nonEmptyString(entry.condition) ?? '',
        failureMode: entry.failureMode === 'closed' ? 'closed' : 'open',
        handlers: [handler],
      })
    }
    if (groups.length) config.hooks[eventName] = groups
  }
  return { config, diagnostics }
}

function parseV2Groups(
  raw: unknown,
  diagnostics: HookDiagnostic[],
): HooksConfigV2['hooks'] {
  const hooks = objectOrNull(raw)
  if (!hooks) return {}
  const normalized: HooksConfigV2['hooks'] = {}
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!isHookEventName(eventName)) {
      diagnostics.push({
        code: 'invalid_event',
        path: `hooks.${eventName}`,
        message: `Unsupported hook event: ${eventName}`,
      })
      continue
    }
    if (!Array.isArray(entries)) {
      diagnostics.push({
        code: 'invalid_hooks_list',
        path: `hooks.${eventName}`,
        message: 'Hook event value must be an array',
      })
      continue
    }
    const groups: HookGroup[] = []
    const seenGroups = new Set<string>()
    for (let index = 0; index < entries.length; index++) {
      const parsed = hookGroupV2Schema.safeParse(entries[index])
      if (!parsed.success) {
        diagnostics.push(
          ...zodDiagnostics(
            parsed.error,
            `hooks.${eventName}.${index}`,
            'invalid_hook_group',
          ),
        )
        continue
      }
      const group = parsed.data
      if (seenGroups.has(group.id)) {
        diagnostics.push({
          code: 'duplicate_group_id',
          path: `hooks.${eventName}.${index}.id`,
          message: `Duplicate hook group id: ${group.id}`,
        })
        continue
      }
      const handlers: HookHandlerV2[] = []
      const seenHandlers = new Set<string>()
      for (
        let handlerIndex = 0;
        handlerIndex < group.handlers.length;
        handlerIndex++
      ) {
        const handler = group.handlers[handlerIndex]!
        if (seenHandlers.has(handler.id)) {
          diagnostics.push({
            code: 'duplicate_handler_id',
            path: `hooks.${eventName}.${index}.handlers.${handlerIndex}.id`,
            message: `Duplicate hook handler id: ${handler.id}`,
          })
          continue
        }
        seenHandlers.add(handler.id)
        handlers.push(handler)
      }
      if (!handlers.length) continue
      seenGroups.add(group.id)
      groups.push({ ...group, handlers })
    }
    if (groups.length) normalized[eventName] = groups
  }
  return normalized
}

function parseLegacyHandlerV2(
  groupId: string,
  handler: Record<string, unknown>,
  path: string,
  diagnostics: HookDiagnostic[],
): HookHandlerV2 | null {
  const type = nonEmptyString(handler.type)
  const base = {
    ...handler,
    id: `${groupId}-handler-1`,
    enabled: handler.enabled === undefined ? true : Boolean(handler.enabled),
    timeoutMs: positiveIntOrUndefined(handler.timeoutMs),
    statusMessage:
      typeof handler.statusMessage === 'string' ? handler.statusMessage : '',
    once: Boolean(handler.once ?? false),
  }
  let candidate: Record<string, unknown>
  if (type === 'command') {
    candidate = {
      ...base,
      type,
      args: stringArray(handler.args),
      shell:
        handler.shell === 'bash' || handler.shell === 'powershell'
          ? handler.shell
          : 'none',
      allowedEnv: stringArray(handler.allowedEnv ?? handler.allowed_env),
      async: Boolean(handler.async ?? false),
      asyncRewake: Boolean(handler.asyncRewake ?? false),
    }
  } else if (type === 'http') {
    candidate = {
      ...base,
      type,
      headers: stringRecord(handler.headers),
      allowedEnv: stringArray(handler.allowedEnv ?? handler.allowed_env),
    }
    delete candidate.async
  } else if (type === 'prompt' || type === 'agent') {
    candidate = {
      ...base,
      type,
      modelRole: handler.modelRole === 'main' ? 'main' : 'secondary',
      ...(type === 'agent'
        ? { maxTurns: positiveInt(handler.maxTurns, 12) }
        : {}),
    }
  } else {
    diagnostics.push({
      code: 'invalid_handler',
      path,
      message: `Unsupported hook handler: ${String(type ?? '')}`,
    })
    return null
  }
  if (candidate.timeoutMs === undefined) delete candidate.timeoutMs
  const parsed = handlerV2Schema.safeParse(candidate)
  if (!parsed.success) {
    diagnostics.push(...zodDiagnostics(parsed.error, path, 'invalid_handler'))
    return null
  }
  return parsed.data
}

function parseV2Policy(
  raw: unknown,
  sourceKind: string,
  diagnostics: HookDiagnostic[],
): HookPolicy {
  if (raw === undefined) return clonePolicy(V2_DEFAULT_POLICY)
  if (sourceKind !== 'global') {
    diagnostics.push({
      code: 'policy_not_allowed',
      path: 'policy',
      message: 'Only the global hooks source may define policy',
    })
    return clonePolicy(V2_DEFAULT_POLICY)
  }
  const parsed = partialPolicySchema.safeParse(raw)
  if (!parsed.success) {
    diagnostics.push(
      ...zodDiagnostics(parsed.error, 'policy', 'invalid_policy'),
    )
    return clonePolicy(V2_DEFAULT_POLICY)
  }
  const value = parsed.data
  return {
    maxConcurrency: value.maxConcurrency ?? V2_DEFAULT_POLICY.maxConcurrency,
    maxContextBytes: value.maxContextBytes ?? V2_DEFAULT_POLICY.maxContextBytes,
    command: {
      ...V2_DEFAULT_POLICY.command,
      ...value.command,
      allowedEnv: [...(value.command?.allowedEnv ?? [])],
    },
    http: {
      ...V2_DEFAULT_POLICY.http,
      ...value.http,
      allowedUrlPatterns: [...(value.http?.allowedUrlPatterns ?? [])],
      allowedEnv: [...(value.http?.allowedEnv ?? [])],
    },
    prompt: { ...V2_DEFAULT_POLICY.prompt, ...value.prompt },
    agent: { ...V2_DEFAULT_POLICY.agent, ...value.agent },
  }
}

function isV1Config(data: Record<string, unknown>): boolean {
  if (data.version === 1) return true
  if (data.version === 2) return false
  const hooks = objectOrNull(data.hooks)
  if (!hooks) return false
  return Object.values(hooks).some(
    (entries) =>
      Array.isArray(entries) &&
      entries.some((entry) => Boolean(objectOrNull(entry)?.handler)),
  )
}

function clonePolicy(policy: HookPolicy): HookPolicy {
  return {
    maxConcurrency: policy.maxConcurrency,
    maxContextBytes: policy.maxContextBytes,
    command: { ...policy.command, allowedEnv: [...policy.command.allowedEnv] },
    http: {
      ...policy.http,
      allowedUrlPatterns: [...policy.http.allowedUrlPatterns],
      allowedEnv: [...policy.http.allowedEnv],
    },
    prompt: { ...policy.prompt },
    agent: { ...policy.agent },
  }
}

function cloneGroup(group: HookGroup): HookGroup {
  return {
    ...group,
    handlers: group.handlers.map((handler) => ({
      ...handler,
      ...('args' in handler ? { args: [...handler.args] } : {}),
      ...('headers' in handler
        ? {
            headers: { ...handler.headers },
            allowedEnv: [...handler.allowedEnv],
          }
        : {}),
      ...('type' in handler && handler.type === 'command'
        ? { allowedEnv: [...handler.allowedEnv] }
        : {}),
    })) as HookHandlerV2[],
  }
}

function zodDiagnostics(
  error: z.ZodError,
  prefix: string,
  code: string,
): HookDiagnostic[] {
  return error.issues.map((issue) => ({
    code,
    path: [prefix, ...issue.path.map(String)].filter(Boolean).join('.'),
    message: issue.message,
  }))
}

function positiveIntOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined
}

export function isHookEventName(value: string): value is HookEventName {
  return EVENT_NAME_SET.has(value)
}

function parseHandler(raw: unknown): HookHandler | null {
  const data = objectOrNull(raw)
  if (!data) return null
  const type = nonEmptyString(data.type)
  if (type === 'command') {
    const command = nonEmptyString(data.command)
    if (!command) return null
    return {
      type: 'command',
      command,
      args: stringArray(data.args),
      timeoutMs: positiveInt(data.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS),
      async: Boolean(data.async ?? false),
      allowedEnv: stringArray(data.allowedEnv ?? data.allowed_env),
    }
  }
  if (type === 'http') {
    const url = nonEmptyString(data.url)
    if (!url) return null
    return {
      type: 'http',
      url,
      timeoutMs: positiveInt(data.timeoutMs, DEFAULT_HTTP_TIMEOUT_MS),
      headers: stringRecord(data.headers),
      async: Boolean(data.async ?? false),
      allowedEnv: stringArray(data.allowedEnv ?? data.allowed_env),
    }
  }
  return null
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function positiveInt(value: unknown, fallback: number): number {
  const num =
    typeof value === 'number'
      ? Math.trunc(value)
      : Number.parseInt(String(value), 10)
  return Number.isFinite(num) && num > 0 ? num : fallback
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (item): item is string =>
        typeof item === 'string' && item.trim().length > 0,
    )
    .map((item) => item.trim())
}

function stringRecord(value: unknown): Record<string, string> {
  const data = objectOrNull(value)
  if (!data) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(data)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}
