export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'ConfigChange',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
] as const

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number]

export type HookHandlerType = 'command' | 'http' | 'prompt' | 'agent'
export type HookFailureMode = 'open' | 'closed'
export type HookEventMode = 'observe' | 'block' | 'transform' | 'continue'

export interface HookEventSpec {
  matcherField: string | null
  mode: HookEventMode
  allowedHandlers: readonly HookHandlerType[]
}

const COMMAND = ['command'] as const
const COMMAND_HTTP = ['command', 'http'] as const
const COMMAND_HTTP_PROMPT = ['command', 'http', 'prompt'] as const
const ALL_HANDLERS = ['command', 'http', 'prompt', 'agent'] as const

export const HOOK_EVENT_SPECS = {
  SessionStart: {
    matcherField: 'source',
    mode: 'observe',
    allowedHandlers: COMMAND,
  },
  SessionEnd: {
    matcherField: 'reason',
    mode: 'observe',
    allowedHandlers: COMMAND,
  },
  UserPromptSubmit: {
    matcherField: null,
    mode: 'transform',
    allowedHandlers: COMMAND_HTTP_PROMPT,
  },
  PreToolUse: {
    matcherField: 'tool_name',
    mode: 'transform',
    allowedHandlers: COMMAND_HTTP_PROMPT,
  },
  PostToolUse: {
    matcherField: 'tool_name',
    mode: 'transform',
    allowedHandlers: COMMAND_HTTP_PROMPT,
  },
  PostToolUseFailure: {
    matcherField: 'tool_name',
    mode: 'observe',
    allowedHandlers: COMMAND_HTTP_PROMPT,
  },
  PermissionRequest: {
    matcherField: 'tool_name',
    mode: 'transform',
    allowedHandlers: COMMAND_HTTP_PROMPT,
  },
  PermissionDenied: {
    matcherField: 'tool_name',
    mode: 'observe',
    allowedHandlers: COMMAND_HTTP_PROMPT,
  },
  Stop: { matcherField: null, mode: 'continue', allowedHandlers: ALL_HANDLERS },
  StopFailure: {
    matcherField: 'error_kind',
    mode: 'observe',
    allowedHandlers: COMMAND_HTTP,
  },
  SubagentStart: {
    matcherField: 'agent_type',
    mode: 'observe',
    allowedHandlers: COMMAND_HTTP_PROMPT,
  },
  SubagentStop: {
    matcherField: 'agent_type',
    mode: 'continue',
    allowedHandlers: ALL_HANDLERS,
  },
  PreCompact: {
    matcherField: 'trigger',
    mode: 'transform',
    allowedHandlers: COMMAND_HTTP_PROMPT,
  },
  PostCompact: {
    matcherField: 'trigger',
    mode: 'observe',
    allowedHandlers: COMMAND_HTTP,
  },
  ConfigChange: {
    matcherField: 'source',
    mode: 'block',
    allowedHandlers: COMMAND_HTTP,
  },
  TaskCreated: {
    matcherField: 'task_kind',
    mode: 'block',
    allowedHandlers: COMMAND_HTTP_PROMPT,
  },
  TaskCompleted: {
    matcherField: 'task_kind',
    mode: 'block',
    allowedHandlers: ALL_HANDLERS,
  },
  TeammateIdle: {
    matcherField: 'agent_type',
    mode: 'continue',
    allowedHandlers: ALL_HANDLERS,
  },
} as const satisfies Record<HookEventName, HookEventSpec>

export type HookSourceKind =
  'global' | 'project' | 'project-local' | 'session' | 'test'

export interface HookHandlerBase {
  id: string
  enabled: boolean
  timeoutMs: number
  statusMessage: string
  once: boolean
}

export interface HookCommandHandler extends HookHandlerBase {
  type: 'command'
  command: string
  args: string[]
  shell: 'none' | 'bash' | 'powershell'
  allowedEnv: string[]
  async: boolean
  asyncRewake: boolean
}

export interface HookHttpHandler extends HookHandlerBase {
  type: 'http'
  url: string
  headers: Record<string, string>
  allowedEnv: string[]
}

export interface HookPromptHandler extends HookHandlerBase {
  type: 'prompt'
  prompt: string
  modelRole: 'secondary' | 'main'
}

export interface HookAgentHandler extends HookHandlerBase {
  type: 'agent'
  prompt: string
  modelRole: 'secondary' | 'main'
  maxTurns: number
}

export type HookHandler =
  HookCommandHandler | HookHttpHandler | HookPromptHandler | HookAgentHandler

export interface HookGroup {
  id: string
  enabled: boolean
  matcher: string
  if: string
  failureMode: HookFailureMode
  handlers: HookHandler[]
}

export interface HookPolicy {
  maxConcurrency: number
  maxContextBytes: number
  command: {
    defaultTimeoutMs: number
    maxTimeoutMs: number
    maxOutputBytes: number
    allowShell: boolean
    allowedEnv: string[]
  }
  http: {
    defaultTimeoutMs: number
    maxTimeoutMs: number
    maxResponseBytes: number
    allowedUrlPatterns: string[]
    allowedEnv: string[]
    allowLoopback: boolean
    allowPrivateNetworks: boolean
  }
  prompt: {
    defaultTimeoutMs: number
    maxTimeoutMs: number
  }
  agent: {
    defaultTimeoutMs: number
    maxTimeoutMs: number
    maxTurns: number
  }
}

export interface HooksConfig {
  version: 2
  enabled: boolean
  projectHooks: { enabled: boolean }
  policy: HookPolicy
  hooks: Partial<Record<HookEventName, HookGroup[]>>
}

export interface HookSource {
  id: string
  kind: HookSourceKind
  rank: number
  path: string
  readonly: boolean
  revision: string
  active: boolean
  blockedReason: string | null
}

export interface ResolvedHookGroup {
  eventName: HookEventName
  group: HookGroup
  source: HookSource
}

export interface ProjectHookTrustStatus {
  canonicalRoot: string
  digest: string
  status: 'trusted' | 'untrusted' | 'stale'
}

export interface HookSnapshot {
  revision: string
  config: HooksConfig
  groups: ResolvedHookGroup[]
  sources: HookSource[]
  diagnostics: HookDiagnostic[]
  projectTrust: ProjectHookTrustStatus | null
}

export interface ParseHooksConfigResult {
  config: HooksConfig
  diagnostics: HookDiagnostic[]
}

export interface HookCommonInput {
  hook_event_name: HookEventName
  session_id: string
  cwd: string
  state_root: string
  turn_id?: string
  project_id?: string
  agent_id?: string
  agent_type?: string
  [key: string]: unknown
}

export type HookInput = HookCommonInput

export interface HookDiagnostic {
  code: string
  path: string
  message: string
}

export type HookDecision = 'deny' | 'ask' | 'allow' | 'passthrough'

export type HookRunStatus = 'completed' | 'failed' | 'timeout' | 'skipped'

export interface HookExecutionResult {
  hookId: string
  hookRunId?: string
  groupId?: string
  handlerId?: string
  handlerType?: HookHandlerType
  source?: HookSource
  status: HookRunStatus
  decision: HookDecision
  reason: string
  durationMs: number
  asyncRewakeEligible?: boolean
  additionalContext?: string
  updatedInput?: Record<string, unknown>
  stdout?: string
  stderr?: string
}

export interface HookAggregateDecision {
  decision: HookDecision
  reason: string
  results: HookExecutionResult[]
  additionalContext: string
  updatedInput?: Record<string, unknown>
  updatedToolOutput?: unknown
  continue?: boolean
  stopReason?: string
  compactInstructions?: string
  suppressOutput?: boolean
  systemMessage?: string
}

export interface HookRuntimeRunOptions {
  sessionId: string
  cwd: string
  projectRoot?: string | null
  stateRoot?: string | null
  source?: string | null
  toolName?: string | null
  toolInput?: Record<string, unknown> | null
  toolResult?: unknown
  permission?: Record<string, unknown> | null
  prompt?: string | null
  signal?: AbortSignal | null
  [key: string]: unknown
}
