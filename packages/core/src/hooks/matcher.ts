import {
  HOOK_EVENT_SPECS,
  type HookDefinition,
  type HookDiagnostic,
  type HookEventName,
  type HookGroup,
  type HookHandlerV2,
  type HookInput,
  type HookSnapshot,
  type HookSourceV2,
  type HooksConfig,
} from './models'

export interface BuildHookInputOptions {
  sessionId: string
  cwd: string
  stateRoot: string
  source?: string | null
  toolName?: string | null
  toolInput?: Record<string, unknown> | null
  toolResult?: unknown
  permission?: Record<string, unknown> | null
  prompt?: string | null
  [key: string]: unknown
}
export function buildHookInput(
  eventName: HookEventName,
  opts: BuildHookInputOptions,
): HookInput {
  const input: HookInput = {
    hook_event_name: eventName,
    session_id: opts.sessionId,
    cwd: opts.cwd,
    state_root: opts.stateRoot,
  }
  if (opts.source !== undefined) input.source = opts.source
  if (opts.toolName) input.tool_name = opts.toolName
  if (opts.toolInput) input.tool_input = opts.toolInput
  if (opts.toolResult !== undefined) input.tool_result = opts.toolResult
  if (opts.permission) input.permission = opts.permission
  if (opts.prompt !== undefined) input.prompt = opts.prompt
  for (const [key, value] of Object.entries(opts)) {
    if (
      [
        'sessionId',
        'cwd',
        'stateRoot',
        'source',
        'toolName',
        'toolInput',
        'toolResult',
        'permission',
        'prompt',
        'signal',
      ].includes(key)
    )
      continue
    if (value !== undefined) input[toSnakeCase(key)] = value
  }
  return input
}

export function findMatchingHooks(
  config: HooksConfig,
  input: HookInput,
): HookDefinition[] {
  if (!config.enabled) return []
  const hooks = config.hooks[input.hook_event_name] ?? []
  return hooks.filter(
    (hook) =>
      hook.enabled &&
      matcherMatches(hook.matcher, input) &&
      conditionMatches(hook.condition, input),
  )
}

export function matcherMatches(matcher: string, input: HookInput): boolean {
  const text = matcher.trim()
  if (!text || text === '*') return true
  const target = matchTarget(input)
  if (!target) return false
  if (text.includes('|'))
    return text
      .split('|')
      .map((part) => part.trim())
      .some((part) => matcherMatches(part, input))
  const regex = parseRegexMatcher(text)
  if (regex) return regex.test(target)
  return text === target
}

export function conditionMatches(condition: string, input: HookInput): boolean {
  const text = condition.trim()
  if (!text) return true
  const tool = /^Tool\(([^)]+)\)$/.exec(text)
  if (tool) return matchPattern(String(input.tool_name ?? ''), tool[1] ?? '')
  if (text.startsWith('path:')) {
    const path = pathFromInput(input)
    return path ? matchGlob(path, text.slice('path:'.length).trim()) : false
  }
  return false
}

export interface CompiledHookPlanItem {
  index: number
  eventName: HookEventName
  groupId: string
  handlerId: string
  group: HookGroup
  handler: HookHandlerV2
  source: HookSourceV2
}

export interface CompiledHookPlan {
  snapshotRevision: string
  items: CompiledHookPlanItem[]
  diagnostics: HookDiagnostic[]
}

export function compileHookPlan(
  snapshot: Pick<HookSnapshot, 'revision' | 'groups'>,
  input: Record<string, unknown>,
): CompiledHookPlan {
  const diagnostics: HookDiagnostic[] = []
  const eventName = String(input.hook_event_name ?? '')
  if (!(eventName in HOOK_EVENT_SPECS)) {
    return {
      snapshotRevision: snapshot.revision,
      items: [],
      diagnostics: [
        {
          code: 'invalid_event',
          path: 'hook_event_name',
          message: `Unsupported hook event: ${eventName}`,
        },
      ],
    }
  }
  const typedEventName = eventName as HookEventName
  const spec = HOOK_EVENT_SPECS[typedEventName]
  const items: CompiledHookPlanItem[] = []
  for (const resolved of snapshot.groups) {
    if (resolved.eventName !== typedEventName || !resolved.group.enabled)
      continue
    const matcher = matcherResult(
      resolved.group.matcher,
      spec.matcherField ? String(input[spec.matcherField] ?? '') : '*',
    )
    if (matcher.error) {
      diagnostics.push({
        code: 'invalid_matcher_regex',
        path: `hooks.${typedEventName}.${resolved.group.id}.matcher`,
        message: matcher.error,
      })
      continue
    }
    if (!matcher.matches) continue
    const condition = conditionResult(resolved.group.if, input)
    if (condition.error) {
      diagnostics.push({
        code: 'unsupported_hook_condition',
        path: `hooks.${typedEventName}.${resolved.group.id}.if`,
        message: condition.error,
      })
      continue
    }
    if (!condition.matches) continue
    for (const handler of resolved.group.handlers) {
      if (!handler.enabled) continue
      if (!(spec.allowedHandlers as readonly string[]).includes(handler.type)) {
        diagnostics.push({
          code: 'handler_not_allowed_for_event',
          path: `hooks.${typedEventName}.${resolved.group.id}.handlers.${handler.id}`,
          message: `${handler.type} handlers are not allowed for ${typedEventName}`,
        })
        continue
      }
      items.push({
        index: items.length,
        eventName: typedEventName,
        groupId: resolved.group.id,
        handlerId: handler.id,
        group: resolved.group,
        handler,
        source: resolved.source,
      })
    }
  }
  return { snapshotRevision: snapshot.revision, items, diagnostics }
}

function matchTarget(input: HookInput): string {
  const field = HOOK_EVENT_SPECS[input.hook_event_name].matcherField
  return field ? String(input[field] ?? '') : '*'
}

function matcherResult(
  matcher: string,
  target: string,
): { matches: boolean; error: string | null } {
  const text = matcher.trim()
  if (!text || text === '*') return { matches: true, error: null }
  if (text.startsWith('/')) {
    const lastSlash = text.lastIndexOf('/')
    if (lastSlash <= 0)
      return { matches: false, error: `Invalid regex matcher: ${text}` }
    try {
      return {
        matches: new RegExp(
          text.slice(1, lastSlash),
          text.slice(lastSlash + 1),
        ).test(target),
        error: null,
      }
    } catch (error) {
      return {
        matches: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  if (text.includes('|')) {
    return {
      matches: text
        .split('|')
        .map((part) => part.trim())
        .some((part) => part === target || part === '*'),
      error: null,
    }
  }
  return { matches: text === target, error: null }
}

function conditionResult(
  condition: string,
  input: Record<string, unknown>,
): { matches: boolean; error: string | null } {
  const text = condition.trim()
  if (!text) return { matches: true, error: null }
  const tool = /^Tool\(([^)]+)\)$/.exec(text)
  if (tool)
    return {
      matches: matchPattern(String(input.tool_name ?? ''), tool[1] ?? ''),
      error: null,
    }
  if (text.startsWith('path:')) {
    const path = pathFromRecord(input)
    return {
      matches: path
        ? matchGlob(path, text.slice('path:'.length).trim())
        : false,
      error: null,
    }
  }
  return { matches: false, error: `Unsupported hook condition: ${text}` }
}

function pathFromRecord(input: Record<string, unknown>): string {
  const toolInput = input.tool_input
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput))
    return ''
  const data = toolInput as Record<string, unknown>
  const value = data.path ?? data.file_path
  return typeof value === 'string' ? value : ''
}

function parseRegexMatcher(text: string): RegExp | null {
  if (!text.startsWith('/') || text.length < 2) return null
  const lastSlash = text.lastIndexOf('/')
  if (lastSlash <= 0) return null
  try {
    return new RegExp(text.slice(1, lastSlash), text.slice(lastSlash + 1))
  } catch {
    return null
  }
}

function matchPattern(value: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1))
  return value === pattern
}

function pathFromInput(input: HookInput): string {
  const toolInput = input.tool_input
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput))
    return ''
  const data = toolInput as Record<string, unknown>
  const value = data.path ?? data.file_path
  return typeof value === 'string' ? value : ''
}

function matchGlob(value: string, glob: string): boolean {
  if (!glob || glob === '*') return true
  return globToRegExp(glob).test(value)
}

function globToRegExp(glob: string): RegExp {
  let pattern = '^'
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? ''
    const next = glob[i + 1] ?? ''
    if (char === '*' && next === '*') {
      const after = glob[i + 2] ?? ''
      if (after === '/') {
        pattern += '(?:.*\\/)?'
        i += 2
      } else {
        pattern += '.*'
        i += 1
      }
      continue
    }
    if (char === '*') {
      pattern += '[^/]*'
      continue
    }
    if (char === '?') {
      pattern += '[^/]'
      continue
    }
    pattern += escapeRegExp(char)
  }
  return new RegExp(`${pattern}$`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}
