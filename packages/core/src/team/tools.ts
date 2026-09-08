import {
  Tool,
  type ToolExecutionContext,
  type ToolResult,
  okResult,
} from '../tools/base'
import { B, I, S, toolParamsSchema } from '../tools/schema'
import { LEAD_ACTOR } from './models'

interface TeamToolManager {
  spawnTeammate(opts: {
    name: string
    role?: string | null
    responsibility?: string | null
    task?: string | null
    agent_type?: string | null
    sender?: string
    parent_call_id?: string | null
    eventSink?: ToolExecutionContext['emit'] | null
    signal?: AbortSignal | null
    session_id?: string | null
  }): Promise<string>
  listTeammates(): string
  sendMessage(opts: {
    to: string
    content: string
    sender?: string
    wake?: boolean
    parent_call_id?: string | null
    eventSink?: ToolExecutionContext['emit'] | null
    signal?: AbortSignal | null
    session_id?: string | null
  }): Promise<string>
  readInbox(opts?: {
    actor?: string
    limit?: number
    mark_read?: boolean
  }): string
  broadcast(opts: {
    content: string
    recipients?: string[] | null
    wake?: boolean
    parent_call_id?: string | null
    eventSink?: ToolExecutionContext['emit'] | null
    signal?: AbortSignal | null
    session_id?: string | null
    parallelism?: number | null
  }): Promise<string>
  shutdownTeammate(opts: {
    name: string
    eventSink?: ToolExecutionContext['emit'] | null
  }): Promise<string>
  cancelTeammateRun(name: string, reason?: string): boolean
}

type TeamManagerProvider = TeamToolManager | (() => TeamToolManager | null)

export class TeamTool extends Tool {
  override requiresRuntimeContext = true
  override evidencePolicy = 'forbidden' as const
  protected readonly managerProvider: TeamManagerProvider
  protected readonly sender: string
  protected readonly actor: string
  protected readonly allowWake: boolean
  override name = 'team_tool'
  override description = 'team tool'
  override parameters = toolParamsSchema({})

  constructor(
    manager: TeamManagerProvider,
    opts: { sender?: string; actor?: string; allowWake?: boolean } = {},
  ) {
    super()
    this.managerProvider = manager
    this.sender = opts.sender ?? LEAD_ACTOR
    this.actor = opts.actor ?? LEAD_ACTOR
    this.allowWake = opts.allowWake ?? true
  }

  execute(_args: Record<string, unknown>): string | Promise<string> {
    return ''
  }

  override mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return okResult(raw, { meta: { tool: this.name, team: true } })
  }

  protected manager(): TeamToolManager {
    const manager =
      typeof this.managerProvider === 'function'
        ? this.managerProvider()
        : this.managerProvider
    if (!manager)
      throw new Error('Team is only available inside Build project sessions')
    return manager
  }
}

export class TeamSpawnTool extends TeamTool {
  override name = 'spawn_teammate'
  override description =
    '创建或唤回一个持久队友。队友会写入 .team/config.json，并拥有独立收件箱和会话；仅当用户需要长期协作角色时使用，短期探索优先 dispatch_subagent。'
  override exclusive = true
  override parameters = toolParamsSchema(
    {
      name: S('队友名称，例如 alice'),
      role: S('队友角色，例如 coder/reviewer/researcher'),
      task: { type: 'string', description: '初始任务；为空则只创建队友' },
      agent_type: { type: 'string', description: '可选子代理身份覆盖' },
      responsibility: {
        type: 'string',
        description:
          '可选的 Team 内职责说明；不会修改基础 Agent 的权限与系统提示词',
      },
    },
    ['name', 'role'],
  )

  override execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    return this.manager().spawnTeammate({
      name: String(args.name ?? ''),
      role: String(args.role ?? ''),
      task: nullableString(args.task),
      agent_type: nullableString(args.agent_type),
      responsibility: nullableString(args.responsibility),
      sender: this.sender,
      parent_call_id: ctx?.parentCallId ?? null,
      eventSink: ctx?.emit ?? null,
      signal: ctx?.signal ?? null,
      session_id: ctx?.sessionId ?? null,
    })
  }
}

export class TeamListTool extends TeamTool {
  override name = 'list_teammates'
  override description =
    '列出当前队友成员、运行状态、未读消息与最近回复。只用于查看持久队友状态，不会唤醒或修改队友。'
  override readOnly = true
  override requiresRuntimeContext = false
  override parameters = toolParamsSchema({})

  override execute(_args?: Record<string, unknown>): string {
    return this.manager().listTeammates()
  }
}

export class TeamSendMessageTool extends TeamTool {
  override name = 'send_message'
  override description =
    '向主控或队友发送一条收件箱消息。主控可设置 wake=true 立即唤醒目标队友；队友发送消息时不会递归唤醒其他队友。仅用于持久 Team 协作，不要替代普通用户回复。'
  override exclusive = true
  override parameters = toolParamsSchema(
    {
      to: S('接收者：lead 或队友名称'),
      content: S('消息内容'),
      wake: B('是否立即唤醒目标队友执行'),
    },
    ['to', 'content'],
  )

  override isReadOnly(_args: Record<string, unknown>): boolean {
    // A teammate reporting back only appends to Cairn-owned coordination
    // metadata and cannot wake another worker. Treat that narrow path as an
    // internal result channel so a completed teammate run is not paused for a
    // workspace-mutation approval. Lead-originated messages remain mutating
    // because they may wake and execute another teammate.
    return this.sender !== LEAD_ACTOR && !this.allowWake
  }

  override execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    return this.manager().sendMessage({
      to: String(args.to ?? ''),
      content: String(args.content ?? ''),
      sender: this.sender,
      wake: Boolean((args.wake ?? true) && this.allowWake),
      parent_call_id: ctx?.parentCallId ?? null,
      eventSink: ctx?.emit ?? null,
      signal: ctx?.signal ?? null,
      session_id: ctx?.sessionId ?? null,
    })
  }
}

export class TeamReadInboxTool extends TeamTool {
  override name = 'read_inbox'
  override description =
    '读取当前角色的队友收件箱。主控读取主控收件箱，队友读取自己的收件箱；只读查看消息，不应代替 send_message 发送回复。'
  // Marking an inbox item as read only updates Cairn-owned coordination
  // metadata. It does not mutate the workspace or an external system, so it
  // must not interrupt a teammate run with a user approval request.
  override readOnly = true
  override exclusive = true
  override requiresRuntimeContext = false
  override parameters = toolParamsSchema({
    limit: I('最多读取多少条未读消息，默认 20；0 表示读取全部未读'),
    mark_read: B('是否把读取到的消息标记为已读，默认 true'),
  })

  override execute(args: Record<string, unknown>): string {
    return this.manager().readInbox({
      actor: this.actor,
      limit: Number(args.limit ?? 20),
      mark_read: Boolean(args.mark_read ?? true),
    })
  }
}

export class TeamBroadcastTool extends TeamTool {
  override name = 'broadcast'
  override description =
    '向多个队友广播消息；默认发送给所有未停用队友，并可逐个唤醒执行。仅用于需要多名持久队友同步上下文的任务，不要代替普通子代理派遣。'
  override exclusive = true
  override parameters = toolParamsSchema(
    {
      content: S('广播内容'),
      recipients: {
        type: 'array',
        items: S('队友名称'),
        description: '队友名称列表；为空则发给所有可用队友',
      },
      wake: B('是否立即唤醒目标队友执行'),
      parallelism: I('唤醒时的并行数；默认 1，运行时会限制为最多 2'),
    },
    ['content'],
  )

  override execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    return this.manager().broadcast({
      content: String(args.content ?? ''),
      recipients: Array.isArray(args.recipients)
        ? args.recipients.map(String)
        : null,
      wake: Boolean(args.wake ?? true),
      parent_call_id: ctx?.parentCallId ?? null,
      eventSink: ctx?.emit ?? null,
      signal: ctx?.signal ?? null,
      session_id: ctx?.sessionId ?? null,
      parallelism: Number(args.parallelism ?? 1),
    })
  }
}

export class TeamShutdownTool extends TeamTool {
  override name = 'shutdown_teammate'
  override description =
    '停用一个队友。记录会保留，但该队友不再接收新任务；属于持久状态变更，除非用户明确要求或计划批准，不要随意调用。'
  override exclusive = true
  override parameters = toolParamsSchema({ name: S('队友名称') }, ['name'])

  override execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    return this.manager().shutdownTeammate({
      name: String(args.name ?? ''),
      eventSink: ctx?.emit ?? null,
    })
  }
}

export class TeamCancelRunTool extends TeamTool {
  override name = 'cancel_teammate_run'
  override description =
    '取消队友当前正在执行的这一轮任务，但保留成员和未确认的 Inbox；仅在用户明确要求停止或当前 Team 任务已不再需要时使用。'
  override exclusive = true
  override parameters = toolParamsSchema(
    {
      name: S('队友名称'),
      reason: S('取消原因'),
    },
    ['name'],
  )

  override execute(args: Record<string, unknown>): string {
    const name = String(args.name ?? '')
    const cancelled = this.manager().cancelTeammateRun(
      name,
      nullableString(args.reason) ?? 'Cancelled by lead',
    )
    return JSON.stringify({ name, cancelled })
  }
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text || null
}
