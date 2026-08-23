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

export interface HookSource {
  kind: 'global' | 'project' | 'project-local' | 'session' | 'test'
  path: string
  readonly: boolean
}

export interface HookCommandHandler {
  type: 'command'
  command: string
  args: string[]
  timeoutMs: number
  async: boolean
  allowedEnv: string[]
}

export interface HookHttpHandler {
  type: 'http'
  url: string
  timeoutMs: number
  headers: Record<string, string>
  async: boolean
  allowedEnv: string[]
}

export type HookHandler = HookCommandHandler | HookHttpHandler

export type HookSourceKind = HookSource['kind']

export interface HookHandlerBaseV2 {
  id: string
  enabled: boolean
  timeoutMs: number
  statusMessage: string
  once: boolean
}

export interface HookCommandHandlerV2 extends HookHandlerBaseV2 {
  type: 'command'
  command: string
  args: string[]
  shell: 'none' | 'bash' | 'powershell'
  allowedEnv: string[]
  async: boolean
  asyncRewake: boolean
}

export interface HookHttpHandlerV2 extends HookHandlerBaseV2 {
  type: 'http'
  url: string
  headers: Record<string, string>
  allowedEnv: string[]
}

export interface HookPromptHandlerV2 extends HookHandlerBaseV2 {
  type: 'prompt'
  prompt: string
  modelRole: 'secondary' | 'main'
}

export interface HookAgentHandlerV2 extends HookHandlerBaseV2 {
  type: 'agent'
  prompt: string
  modelRole: 'secondary' | 'main'
  maxTurns: number
}

export type HookHandlerV2 =
  | HookCommandHandlerV2
  | HookHttpHandlerV2
  | HookPromptHandlerV2
  | HookAgentHandlerV2

export interface HookGroup {
  id: string
  enabled: boolean
  matcher: string
  if: string
  failureMode: HookFailureMode
  handlers: HookHandlerV2[]
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

export interface HooksConfigV2 {
  version: 2
  enabled: boolean
  projectHooks: { enabled: boolean }
  policy: HookPolicy
  hooks: Partial<Record<HookEventName, HookGroup[]>>
}

export interface HookSourceV2 {
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
  source: HookSourceV2
}

export interface ProjectHookTrustStatus {
  canonicalRoot: string
  digest: string
  status: 'trusted' | 'untrusted' | 'stale'
}

export interface HookSnapshot {
  revision: string
  config: HooksConfigV2
  groups: ResolvedHookGroup[]
  sources: HookSourceV2[]
  diagnostics: HookDiagnostic[]
  projectTrust: ProjectHookTrustStatus | null
}

export interface ParseHooksConfigV2Result {
  config: HooksConfigV2
  diagnostics: HookDiagnostic[]
}

export interface HookCommonInputV2 {
  hook_event_name: HookEventName
  session_id: string
  cwd: string
  state_root: string
  turn_id?: string
  project_id?: string
  agent_id?: string
  agent_type?: string
}

export type HookInputByEvent = {
  SessionStart: { source: string }
  SessionEnd: { reason: string }
  UserPromptSubmit: { prompt: string }
  PreToolUse: {
    tool_name: string
    tool_input: Record<string, unknown>
    tool_use_id: string
  }
  PostToolUse: {
    tool_name: string
    tool_input: Record<string, unknown>
    tool_use_id: string
    tool_result: unknown
  }
  PostToolUseFailure: {
    tool_name: string
    tool_input: Record<string, unknown>
    tool_use_id: string
    error: string
  }
  PermissionRequest: {
    tool_name: string
    tool_input: Record<string, unknown>
    tool_use_id: string
    permission: Record<string, unknown>
  }
  PermissionDenied: {
    tool_name: string
    tool_input: Record<string, unknown>
    tool_use_id: string
    permission: Record<string, unknown>
  }
  Stop: { last_assistant_message: string; stop_hook_active: boolean }
  StopFailure: { error_kind: string; error: string }
  SubagentStart: { agent_id: string; agent_type: string }
  SubagentStop: {
    agent_id: string
    agent_type: string
    last_assistant_message: string
    stop_hook_active: boolean
  }
  PreCompact: { trigger: 'manual' | 'auto' | 'emergency' }
  PostCompact: {
    trigger: 'manual' | 'auto' | 'emergency'
    result: Record<string, unknown>
  }
  ConfigChange: { source: string; candidate_revision: string }
  TaskCreated: { task_kind: string; task: Record<string, unknown> }
  TaskCompleted: { task_kind: string; task: Record<string, unknown> }
  TeammateIdle: {
    agent_id: string
    agent_type: string
    teammate_name: string
    stop_hook_active: boolean
  }
}

export type HookInputV2<E extends HookEventName = HookEventName> =
  HookCommonInputV2 & { hook_event_name: E } & HookInputByEvent[E]

export interface HookDefinition {
  id: string
  eventName: HookEventName
  enabled: boolean
  matcher: string
  condition: string
  handler: HookHandler
  source: HookSource | null
}

export interface HooksConfig {
  version: 1
  enabled: boolean
  projectHooks: {
    enabled: boolean
  }
  hooks: Partial<Record<HookEventName, HookDefinition[]>>
}

export interface HookDiagnostic {
  code: string
  path: string
  message: string
}

export interface ParseHooksConfigResult {
  config: HooksConfig
  diagnostics: HookDiagnostic[]
}

export type HookDecision = 'deny' | 'ask' | 'allow' | 'passthrough'

export type HookRunStatus = 'completed' | 'failed' | 'timeout' | 'skipped'

export interface HookAuditRecord {
  id: string
  hookId: string
  eventName: HookEventName
  handlerType: HookHandlerType
  source: HookSource
  startedAt: string
  durationMs: number
  status: HookRunStatus
  decision: HookDecision
  reason: string
}

export interface HookExecutionResult {
  hookId: string
  hookRunId?: string
  groupId?: string
  handlerId?: string
  handlerType?: HookHandlerType
  source?: HookSourceV2
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

export type HookInput = Record<string, unknown> & {
  hook_event_name: HookEventName
  session_id: string
  cwd: string
  state_root: string
}
