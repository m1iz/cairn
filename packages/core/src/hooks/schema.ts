import { z } from 'zod'
import {
  HOOK_EVENT_NAMES,
  type HookAgentHandler,
  type HookCommandHandler,
  type HookDiagnostic,
  type HookEventName,
  type HookGroup,
  type HookHandler,
  type HookHttpHandler,
  type HookPolicy,
  type HookPromptHandler,
  type HookSourceKind,
  type HooksConfig,
  type ParseHooksConfigResult,
} from './models'

const EVENT_NAME_SET = new Set<string>(HOOK_EVENT_NAMES)

const DEFAULT_HOOK_POLICY: HookPolicy = {
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

const commandHandlerSchema = z
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
  .transform((value): HookCommandHandler => ({
    ...value,
    timeoutMs: value.timeoutMs ?? DEFAULT_HOOK_POLICY.command.defaultTimeoutMs,
  }))

const httpHandlerSchema = z
  .object({
    ...handlerBaseShape,
    type: z.literal('http'),
    url: z.url(),
    headers: stringMapSchema,
    allowedEnv: stringListSchema,
  })
  .strict()
  .transform((value): HookHttpHandler => ({
    ...value,
    timeoutMs: value.timeoutMs ?? DEFAULT_HOOK_POLICY.http.defaultTimeoutMs,
  }))

const promptHandlerSchema = z
  .object({
    ...handlerBaseShape,
    type: z.literal('prompt'),
    prompt: nonEmptyTextSchema,
    modelRole: z.enum(['secondary', 'main']).default('secondary'),
  })
  .strict()
  .transform((value): HookPromptHandler => ({
    ...value,
    timeoutMs: value.timeoutMs ?? DEFAULT_HOOK_POLICY.prompt.defaultTimeoutMs,
  }))

const agentHandlerSchema = z
  .object({
    ...handlerBaseShape,
    type: z.literal('agent'),
    prompt: nonEmptyTextSchema,
    modelRole: z.enum(['secondary', 'main']).default('secondary'),
    maxTurns: z.number().int().min(1).max(12).default(12),
  })
  .strict()
  .transform((value): HookAgentHandler => ({
    ...value,
    timeoutMs: value.timeoutMs ?? DEFAULT_HOOK_POLICY.agent.defaultTimeoutMs,
  }))

const handlerSchema = z.union([
  commandHandlerSchema,
  httpHandlerSchema,
  promptHandlerSchema,
  agentHandlerSchema,
])

const hookGroupSchema = z
  .object({
    id: nonEmptyTextSchema,
    enabled: z.boolean().default(true),
    matcher: z.string().trim().default('*'),
    if: z.string().trim().default(''),
    failureMode: z.enum(['open', 'closed']).default('open'),
    handlers: z.array(handlerSchema).min(1),
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
    version: 2,
    enabled: true,
    projectHooks: { enabled: false },
    policy: clonePolicy(DEFAULT_HOOK_POLICY),
    hooks: {},
  }
}

export function parseHooksConfig(
  raw: unknown,
  opts: { sourceKind?: HookSourceKind | string } = {},
): ParseHooksConfigResult {
  const data = objectOrNull(raw)
  if (!data) return { config: defaultHooksConfig(), diagnostics: [] }
  const sourceKind = String(opts.sourceKind ?? 'global')
  return isV1Config(data)
    ? parseLegacyConfig(data, sourceKind)
    : parseCurrentConfig(data, sourceKind)
}

export function serializeHooksConfig(
  config: HooksConfig,
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

function parseCurrentConfig(
  data: Record<string, unknown>,
  sourceKind: string,
): ParseHooksConfigResult {
  const diagnostics: HookDiagnostic[] = []
  const config = defaultHooksConfig()
  config.enabled = data.enabled === undefined ? true : Boolean(data.enabled)
  config.projectHooks.enabled = Boolean(
    objectOrNull(data.projectHooks)?.enabled ?? false,
  )
  config.policy = parseHookPolicy(data.policy, sourceKind, diagnostics)
  config.hooks = parseHookGroups(data.hooks, diagnostics)
  return { config, diagnostics }
}

function parseLegacyConfig(
  data: Record<string, unknown>,
  sourceKind: string,
): ParseHooksConfigResult {
  const diagnostics: HookDiagnostic[] = []
  const config = defaultHooksConfig()
  config.enabled = data.enabled === undefined ? true : Boolean(data.enabled)
  config.projectHooks.enabled = Boolean(
    objectOrNull(data.projectHooks)?.enabled ??
    objectOrNull(data.project_hooks)?.enabled ??
    false,
  )
  config.policy = parseHookPolicy(data.policy, sourceKind, diagnostics)
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
      const handler = parseLegacyHandler(
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

function parseHookGroups(
  raw: unknown,
  diagnostics: HookDiagnostic[],
): HooksConfig['hooks'] {
  const hooks = objectOrNull(raw)
  if (!hooks) return {}
  const normalized: HooksConfig['hooks'] = {}
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
      const parsed = hookGroupSchema.safeParse(entries[index])
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
      const handlers: HookHandler[] = []
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

function parseLegacyHandler(
  groupId: string,
  handler: Record<string, unknown>,
  path: string,
  diagnostics: HookDiagnostic[],
): HookHandler | null {
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
  const parsed = handlerSchema.safeParse(candidate)
  if (!parsed.success) {
    diagnostics.push(...zodDiagnostics(parsed.error, path, 'invalid_handler'))
    return null
  }
  return parsed.data
}

function parseHookPolicy(
  raw: unknown,
  sourceKind: string,
  diagnostics: HookDiagnostic[],
): HookPolicy {
  if (raw === undefined) return clonePolicy(DEFAULT_HOOK_POLICY)
  if (sourceKind !== 'global') {
    diagnostics.push({
      code: 'policy_not_allowed',
      path: 'policy',
      message: 'Only the global hooks source may define policy',
    })
    return clonePolicy(DEFAULT_HOOK_POLICY)
  }
  const parsed = partialPolicySchema.safeParse(raw)
  if (!parsed.success) {
    diagnostics.push(
      ...zodDiagnostics(parsed.error, 'policy', 'invalid_policy'),
    )
    return clonePolicy(DEFAULT_HOOK_POLICY)
  }
  const value = parsed.data
  return {
    maxConcurrency: value.maxConcurrency ?? DEFAULT_HOOK_POLICY.maxConcurrency,
    maxContextBytes:
      value.maxContextBytes ?? DEFAULT_HOOK_POLICY.maxContextBytes,
    command: {
      ...DEFAULT_HOOK_POLICY.command,
      ...value.command,
      allowedEnv: [...(value.command?.allowedEnv ?? [])],
    },
    http: {
      ...DEFAULT_HOOK_POLICY.http,
      ...value.http,
      allowedUrlPatterns: [...(value.http?.allowedUrlPatterns ?? [])],
      allowedEnv: [...(value.http?.allowedEnv ?? [])],
    },
    prompt: { ...DEFAULT_HOOK_POLICY.prompt, ...value.prompt },
    agent: { ...DEFAULT_HOOK_POLICY.agent, ...value.agent },
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
    })) as HookHandler[],
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
