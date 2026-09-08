import { ToolRegistry } from '../tools/registry'
import { MessageBus } from './bus'
import * as events from './events'
import {
  LEAD_ACTOR,
  TeamMember,
  TeamMessage,
  TeamStatus,
  newTeamId,
  validateMemberName,
  type TeamMemberPayload,
  type TeamMessagePayload,
} from './models'
import {
  TEAM_CHECKPOINT_VERSION,
  TeamStore,
  teamThreadRevision,
  type TeamCheckpointPayload,
  type TeamEffectReceipt,
} from './store'
import type { TeamConfigPayload } from './store'
import { TeamReadInboxTool, TeamSendMessageTool } from './tools'
import type { HookAggregateDecision } from '../hooks/models'
import { CallbackHarnessHost } from '../agent/harness-host'
import { TeamRunController, type TeamRunLease } from './runtime'
import { TurnPaused } from '../control/exceptions'
import { EXECUTION_BUDGET_EXHAUSTED_PREFIX } from '../agent/runner-helpers'

const ROLE_AGENT_TYPES: Record<string, string> = {
  coder: 'implementation_engineer',
  reviewer: 'inventory_reviewer',
  researcher: 'web_researcher',
  reader: 'code_explorer',
  runner: 'quick_check',
}
const RECURSIVE_TEAM_TOOLS = new Set([
  'dispatch_subagent',
  'spawn_teammate',
  'team_spawn',
  'broadcast',
])

export function roleToAgentType(role: string): string {
  return (
    ROLE_AGENT_TYPES[
      String(role || '')
        .trim()
        .toLowerCase()
    ] ?? 'code_explorer'
  )
}

export interface TeamSubagentSpec {
  name?: string
  description?: string
  systemPrompt?: string
  tool_names?: string[]
  toolNames?: string[]
  maxTurns?: number
  definition?: {
    model?: { allowedProfiles?: string[] }
    sandbox?: {
      filesystem?: string
      network?: string
      process?: string
    }
  }
}
export interface TeamSubagentRegistry {
  get(name: string): TeamSubagentSpec | null | undefined
  resolveName?(name: string): string
  names?(includeAliases?: boolean): string[]
}
export interface TeamRunner {
  step(
    history: Array<Record<string, unknown>>,
    opts?: { signal?: AbortSignal | null },
  ): string | Promise<string>
  stepStream?(
    history: Array<Record<string, unknown>>,
    emit: (event: Record<string, unknown>) => Promise<void>,
    opts?: { signal?: AbortSignal | null },
  ): Promise<string>
}
export type TeamRunnerFactory = (opts: {
  member: TeamMember
  spec: TeamSubagentSpec
  subRegistry: ToolRegistry
  agentId: string
}) => TeamRunner
export type TeamEventSink = (
  event: Record<string, unknown>,
) => Promise<void> | void
export type TeamCheckpointRecovery = 'auto' | 'retry'
export interface TeamHookHost {
  begin(opts: {
    agentId: string
    agentType: string
    teammateName: string
  }): Promise<HookAggregateDecision>
  end(agentId: string): void
}

export interface TeamMemberSummaryPayload extends TeamMemberPayload {
  unread: number
  recent_messages: TeamMessagePayload[]
  thread_count: number
  tools: string[]
  active_run?: TeamRunSummaryPayload | null
}

export interface TeamRunSummaryPayload {
  turn_id: string
  phase: 'prepared' | 'running' | 'terminal_pending'
  pending_messages: number
  recovery: 'automatic' | 'explicit' | 'finalizing'
  started_at?: number
  deadline_at?: number
}

export const TEAM_MAX_TURNS_CAP = 20
export const TEAM_RESULT_MAX_CHARS = 64_000

export function resolveTeamMaxTurns(
  spec: TeamSubagentSpec,
  cap = TEAM_MAX_TURNS_CAP,
): number {
  const safeCap = Math.max(1, Math.min(100, Math.trunc(Number(cap) || 1)))
  const configured = Math.trunc(Number(spec.maxTurns ?? 12))
  return Math.max(
    1,
    Math.min(safeCap, Number.isFinite(configured) ? configured : 12),
  )
}

export function boundTeamResult(
  result: string,
  maxChars = TEAM_RESULT_MAX_CHARS,
): string {
  const limit = Math.max(1, Math.trunc(Number(maxChars) || 1))
  if (result.length <= limit) return result
  return `${result.slice(0, limit)}\n\n[Team output truncated at ${limit} characters]`
}

export interface TeamManagerPayload {
  config: TeamConfigPayload
  members: TeamMemberSummaryPayload[]
  available_agent_types?: string[]
  available_agent_profiles?: TeamAgentProfilePayload[]
  leadUnread: number
  leadInbox: TeamMessagePayload[]
}

export interface TeamAgentProfilePayload {
  name: string
  description: string
  tools: string[]
  filesystem: string
  network: string
  process: string
}

interface ValidatedTeamCheckpoint {
  payload: TeamCheckpointPayload
  history: Array<Record<string, unknown>>
  turnId: string
  cursorStart: number
  cursorEnd: number
  pendingIds: string[]
  baseThreadRevision: string
  leadBefore: Set<string>
}

export class TeamManager {
  readonly projectId: string | null
  /** Stable execution namespace. Unlike projectId, this can isolate global conversations. */
  readonly runtimeScopeId: string
  readonly store: TeamStore
  readonly bus: MessageBus
  readonly parentRegistry: ToolRegistry
  readonly subagentRegistry: TeamSubagentRegistry
  readonly runnerFactory: TeamRunnerFactory | null
  readonly eventSink: TeamEventSink | null
  readonly hooks: TeamHookHost | null
  readonly runController: TeamRunController
  readonly sessionIdProvider: (() => string | null) | null
  private working = new Set<string>()
  private readonly preferExplicitReport: boolean

  constructor(opts: {
    root: string
    teamDir?: string | null
    projectId?: string | null
    runtimeScopeId?: string | null
    parentRegistry?: ToolRegistry | null
    subagentRegistry: TeamSubagentRegistry
    runnerFactory?: TeamRunnerFactory | null
    eventSink?: TeamEventSink | null
    hooks?: TeamHookHost | null
    runController?: TeamRunController | null
    sessionIdProvider?: (() => string | null) | null
    preferExplicitReport?: boolean
  }) {
    this.projectId = opts.projectId?.trim() || null
    this.runtimeScopeId =
      opts.runtimeScopeId?.trim() || this.projectId || 'global'
    this.store = new TeamStore(opts.root, { teamDir: opts.teamDir ?? null })
    this.bus = new MessageBus(this.store)
    this.parentRegistry = opts.parentRegistry ?? new ToolRegistry()
    this.subagentRegistry = opts.subagentRegistry
    this.runnerFactory = opts.runnerFactory ?? null
    this.eventSink = opts.eventSink ?? null
    this.hooks = opts.hooks ?? null
    this.runController = opts.runController ?? new TeamRunController()
    this.sessionIdProvider = opts.sessionIdProvider ?? null
    this.preferExplicitReport = opts.preferExplicitReport === true
  }

  payload(): TeamManagerPayload {
    const members = this.store.listMembers().map((member) => ({
      ...member.toDict(),
      unread: this.bus.unreadCount(member.name),
      recent_messages: this.bus
        .recent(member.name, { limit: 5 })
        .map((msg) => msg.toDict()),
      thread_count: this.store.readThread(member.name).length,
      tools: this.toolNamesForMember(member),
      active_run: this.runSummary(member.name),
    }))
    const availableAgentTypes = this.subagentRegistry.names?.(false) ?? []
    return {
      config: this.store.loadConfig(),
      members,
      available_agent_types: availableAgentTypes,
      available_agent_profiles: availableAgentTypes.flatMap((name) => {
        const spec = this.subagentRegistry.get(name)
        if (!spec) return []
        return [
          {
            name: spec.name ?? name,
            description: spec.description ?? '',
            tools: [...(spec.tool_names ?? spec.toolNames ?? [])],
            filesystem: spec.definition?.sandbox?.filesystem ?? 'read-only',
            network: spec.definition?.sandbox?.network ?? 'deny',
            process: spec.definition?.sandbox?.process ?? 'deny',
          },
        ]
      }),
      leadUnread: this.bus.unreadCount(LEAD_ACTOR),
      leadInbox: this.bus
        .recent(LEAD_ACTOR, { limit: 50 })
        .map((msg) => msg.toDict()),
    }
  }

  runSummary(name: string): TeamRunSummaryPayload | null {
    const checkpoint = this.store.readCheckpointPayload(name)
    if (!checkpoint?.turn_id || !checkpoint.phase) return null
    const active = this.runController
      .snapshot(this.runtimeScopeId)
      .find(
        (run) => run.memberName === name && run.turnId === checkpoint.turn_id,
      )
    return {
      turn_id: checkpoint.turn_id,
      phase: checkpoint.phase,
      pending_messages: checkpoint.pending_message_ids?.length ?? 0,
      recovery:
        checkpoint.phase === 'prepared'
          ? 'automatic'
          : checkpoint.phase === 'terminal_pending'
            ? 'finalizing'
            : 'explicit',
      ...(active
        ? { started_at: active.startedAt, deadline_at: active.deadlineAt }
        : {}),
    }
  }

  async spawnTeammate(opts: {
    name: string
    role?: string | null
    responsibility?: string | null
    task?: string | null
    agent_type?: string | null
    sender?: string
    parent_call_id?: string | null
    eventSink?: TeamEventSink | null
    signal?: AbortSignal | null
    session_id?: string | null
  }): Promise<string> {
    const safeName = validateMemberName(opts.name)
    const resolved = opts.agent_type || roleToAgentType(opts.role ?? '')
    const spec = this.subagentRegistry.get(resolved)
    if (!spec)
      return `Error: unknown agent_type '${resolved}'. Available: ${this.subagentRegistry.names?.(true) ?? []}`
    const existing = this.store.getMember(safeName)
    const agentType =
      this.subagentRegistry.resolveName?.(resolved) ?? spec.name ?? resolved
    const member = new TeamMember({
      name: safeName,
      role: String(opts.role || agentType),
      agent_type: agentType,
      responsibility:
        opts.responsibility === undefined
          ? (existing?.responsibility ?? '')
          : normalizeResponsibility(opts.responsibility),
      status:
        existing && existing.status !== TeamStatus.SHUTDOWN
          ? existing.status
          : TeamStatus.IDLE,
      created_at: existing?.created_at,
      last_error: existing?.last_error ?? null,
    })
    this.store.upsertMember(member)
    await this.emit(events.memberUpdate(member), opts.eventSink)
    if (!opts.task) return JSON.stringify({ created: member.toDict() })

    const taskId = newTeamId('task')
    const msg = this.bus.send({
      from_actor: opts.sender ?? LEAD_ACTOR,
      to: member.name,
      content: opts.task,
      type: 'task',
      task_id: taskId,
    })
    await this.emit(events.messageEvent(msg), opts.eventSink)
    const result = await this.wakeTeammate(member.name, {
      parent_call_id: opts.parent_call_id ?? null,
      purpose: opts.task.slice(0, 120),
      eventSink: opts.eventSink ?? null,
      signal: opts.signal ?? null,
      session_id: opts.session_id ?? null,
    })
    return JSON.stringify({
      created: member.toDict(),
      message: msg.toDict(),
      result,
    })
  }

  listTeammates(): string {
    return JSON.stringify(this.payload(), null, 2)
  }

  readInbox(
    opts: { actor?: string; limit?: number; mark_read?: boolean } = {},
  ): string {
    const messages = this.bus.read(opts.actor ?? LEAD_ACTOR, {
      limit: opts.limit ?? 20,
      mark_read: opts.mark_read ?? true,
    })
    return JSON.stringify(
      messages.map((msg) => msg.toDict()),
      null,
      2,
    )
  }

  async sendMessage(opts: {
    to: string
    content: string
    sender?: string
    wake?: boolean
    type?: string
    parent_call_id?: string | null
    eventSink?: TeamEventSink | null
    signal?: AbortSignal | null
    session_id?: string | null
  }): Promise<string> {
    if (opts.to !== LEAD_ACTOR) this.requireMember(opts.to)
    if ((opts.sender ?? LEAD_ACTOR) !== LEAD_ACTOR)
      this.requireMember(opts.sender ?? LEAD_ACTOR)
    const msg = this.bus.send({
      from_actor: opts.sender ?? LEAD_ACTOR,
      to: opts.to,
      content: opts.content,
      type: opts.type ?? 'message',
    })
    await this.emit(events.messageEvent(msg), opts.eventSink)
    let result: string | null = null
    if ((opts.wake ?? true) && opts.to !== LEAD_ACTOR)
      result = await this.wakeTeammate(opts.to, {
        parent_call_id: opts.parent_call_id ?? null,
        purpose: opts.content.slice(0, 120),
        eventSink: opts.eventSink ?? null,
        signal: opts.signal ?? null,
        session_id: opts.session_id ?? null,
      })
    return JSON.stringify({ message: msg.toDict(), result })
  }

  async broadcast(opts: {
    content: string
    recipients?: string[] | null
    wake?: boolean
    parent_call_id?: string | null
    eventSink?: TeamEventSink | null
    signal?: AbortSignal | null
    session_id?: string | null
    parallelism?: number | null
  }): Promise<string> {
    let members = this.store
      .listMembers()
      .filter((member) => member.status !== TeamStatus.SHUTDOWN)
    if (opts.recipients?.length) {
      const wanted = new Set(opts.recipients.map(validateMemberName))
      members = members.filter((member) => wanted.has(member.name))
    }
    const sent: Array<Record<string, unknown>> = []
    for (const member of members) {
      const msg = this.bus.send({
        from_actor: LEAD_ACTOR,
        to: member.name,
        content: opts.content,
        type: 'message',
      })
      sent.push(msg.toDict())
      await this.emit(events.messageEvent(msg), opts.eventSink)
    }
    const results: Array<Record<string, unknown>> = []
    if (opts.wake ?? true) {
      const parallelism = Math.max(
        1,
        Math.min(2, Math.trunc(Number(opts.parallelism ?? 1)) || 1),
      )
      const settled = await mapConcurrent(
        members,
        parallelism,
        async (member) => {
          try {
            return await this.wakeTeammate(member.name, {
              parent_call_id: opts.parent_call_id ?? null,
              purpose: opts.content.slice(0, 120),
              eventSink: opts.eventSink ?? null,
              signal: opts.signal ?? null,
              session_id: opts.session_id ?? null,
            })
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`
          }
        },
      )
      results.push(
        ...members.map((member, index) => ({
          name: member.name,
          result: settled[index],
        })),
      )
    }
    return JSON.stringify({ sent, results }, null, 2)
  }

  async shutdownTeammate(opts: {
    name: string
    eventSink?: TeamEventSink | null
  }): Promise<string> {
    this.cancelTeammateRun(opts.name, 'Teammate shutdown')
    const member = this.store.updateMember(opts.name, {
      status: TeamStatus.SHUTDOWN,
      last_error: null,
    })
    await this.emit(events.memberUpdate(member), opts.eventSink)
    return JSON.stringify({ shutdown: member.toDict() })
  }

  cancelTeammateRun(name: string, reason = 'Team run cancelled'): boolean {
    const member = this.requireMember(name)
    return this.runController.cancel(this.runtimeScopeId, member.name, reason)
  }

  async wakeTeammate(
    name: string,
    opts: {
      parent_call_id?: string | null
      purpose?: string
      eventSink?: TeamEventSink | null
      recovery?: TeamCheckpointRecovery
      signal?: AbortSignal | null
      session_id?: string | null
    } = {},
  ): Promise<string> {
    const member = this.requireMember(name)
    if (member.status === TeamStatus.SHUTDOWN)
      return `Error: teammate '${member.name}' is shutdown`
    if (this.working.has(member.name))
      return `Error: teammate '${member.name}' is already working`
    this.working.add(member.name)
    try {
      return await this.wakeLocked(member, opts)
    } finally {
      this.working.delete(member.name)
    }
  }

  private async wakeLocked(
    member: TeamMember,
    opts: {
      parent_call_id?: string | null
      purpose?: string
      eventSink?: TeamEventSink | null
      recovery?: TeamCheckpointRecovery
      signal?: AbortSignal | null
      session_id?: string | null
    },
  ): Promise<string> {
    const working = this.store.updateMember(member.name, {
      status: TeamStatus.WORKING,
      last_error: null,
    })
    await this.emit(events.memberUpdate(working), opts.eventSink)
    await this.emit(
      events.runStart({
        parent_id: opts.parent_call_id ?? null,
        member: working,
        purpose: opts.purpose ?? '',
      }),
      opts.eventSink,
    )

    const inbox = this.bus.allMessages(working.name)
    const storedCheckpoint = this.store.readCheckpointPayload(working.name)
    if (!storedCheckpoint && this.store.hasCheckpoint(working.name))
      return this.failCheckpointRecovery(
        working,
        'checkpoint is corrupt or cannot be decoded; refusing an unsafe automatic replay',
        opts,
      )
    let run: ValidatedTeamCheckpoint
    if (storedCheckpoint) {
      const recovered = this.validateCheckpoint(
        working,
        storedCheckpoint,
        inbox,
      )
      if (typeof recovered === 'string')
        return this.failCheckpointRecovery(working, recovered, opts)
      run = recovered
      if (storedCheckpoint.phase === 'terminal_pending')
        return this.finalizeCheckpoint(
          working,
          run,
          storedCheckpoint.last_effect_receipt as TeamEffectReceipt,
          opts,
        )
      if (
        storedCheckpoint.phase === 'running' &&
        (opts.recovery ?? 'auto') !== 'retry'
      ) {
        return this.failCheckpointRecovery(
          working,
          `ambiguous running checkpoint '${run.turnId}'; automatic replay is disabled to avoid duplicate side effects. Retry explicitly with recovery='retry'`,
          opts,
        )
      }
    } else {
      const cursorStart = Math.min(
        this.store.readCursor(working.name),
        inbox.length,
      )
      const unread = inbox.slice(cursorStart, cursorStart + 50)
      if (!unread.length) {
        const current = this.requireMember(working.name)
        const idle =
          current.status === TeamStatus.SHUTDOWN
            ? current
            : this.store.updateMember(working.name, {
                status: TeamStatus.IDLE,
                last_error: null,
              })
        if (idle.status !== TeamStatus.SHUTDOWN)
          await this.emit(events.memberUpdate(idle), opts.eventSink)
        await this.emit(
          events.runDone({
            parent_id: opts.parent_call_id ?? null,
            member: idle,
            summary: '没有未读消息。',
          }),
          opts.eventSink,
        )
        return '没有未读消息。'
      }

      const history = this.store.readThread(working.name)
      const baseThreadRevision = teamThreadRevision(history)
      history.push({
        role: 'user',
        content: TeamManager.renderInboxForRunner(working, unread),
      })
      const pendingIds = unread.map((msg) => msg.id)
      const turnId = newTeamId('turn')
      const leadBefore = new Set(
        this.bus.allMessages(LEAD_ACTOR).map((msg) => msg.id),
      )
      run = {
        payload: {
          version: 1,
          member: working.name,
          messages: history,
          checkpoint_version: TEAM_CHECKPOINT_VERSION,
          turn_id: turnId,
          phase: 'prepared',
          base_thread_revision: baseThreadRevision,
          pending_cursor_start: cursorStart,
          pending_cursor_end: cursorStart + unread.length,
          pending_message_ids: pendingIds,
          lead_message_ids_before: [...leadBefore],
        },
        history,
        turnId,
        cursorStart,
        cursorEnd: cursorStart + unread.length,
        pendingIds,
        baseThreadRevision,
        leadBefore,
      }
      this.writeRunCheckpoint(working.name, run, 'prepared')
    }

    if (!this.runnerFactory)
      return this.failCheckpointRecovery(
        working,
        'team runner factory is unavailable',
        opts,
      )
    const agentId = newTeamId('agent')
    let hookScopeStarted = false
    let executionStarted = false
    let lease: TeamRunLease | null = null

    try {
      // An explicit retry acknowledges that a previous `running` attempt may
      // already have produced effects. Re-enter `prepared` before any await so
      // a second crash before model execution remains safely resumable.
      this.writeRunCheckpoint(working.name, run, 'prepared')
      const spec = this.requireSpec(working.agent_type)
      if (this.hooks) {
        const start = await this.hooks.begin({
          agentId,
          agentType: working.agent_type,
          teammateName: working.name,
        })
        hookScopeStarted = true
        const hookContext = start.additionalContext.trim()
        if (
          hookContext &&
          !run.history.some(
            (message) =>
              message.content ===
              `[SubagentStart hook context]\n${hookContext}`,
          )
        ) {
          run.history.splice(Math.max(0, run.history.length - 1), 0, {
            role: 'system',
            content: `[SubagentStart hook context]\n${hookContext}`,
            ui_hidden: true,
          })
        }
        this.writeRunCheckpoint(working.name, run, 'prepared')
      }
      const runner = this.runnerFactory({
        member: working,
        spec,
        subRegistry: this.registryForMember(working, spec),
        agentId,
      })
      lease = this.runController.acquire({
        projectId: this.runtimeScopeId,
        memberName: working.name,
        turnId: run.turnId,
        sessionId:
          opts.session_id?.trim() || this.sessionIdProvider?.() || null,
        signal: opts.signal ?? null,
      })
      const host = new CallbackHarnessHost<
        {
          history: Array<Record<string, unknown>>
          emit: (event: Record<string, unknown>) => Promise<void>
          signal: AbortSignal
        },
        string
      >(async ({ history, emit, signal }) =>
        runner.stepStream
          ? runner.stepStream(history, emit, { signal })
          : runner.step(history, { signal }),
      )
      this.writeRunCheckpoint(working.name, run, 'running')
      executionStarted = true
      const final = boundTeamResult(
        await host.submitTurn({
          history: run.history,
          emit: async (evt) => {
            await this.emit(
              this.mapRunnerEvent(evt, working, opts.parent_call_id ?? null) ??
                evt,
              opts.eventSink,
            )
          },
          signal: lease.signal,
        }),
      )
      const explicitMessages = this.bus
        .allMessages(LEAD_ACTOR)
        .filter(
          (msg) =>
            !run.leadBefore.has(msg.id) && msg.from_actor === working.name,
        )
      const explicitReply = explicitMessages.length > 0
      if (final.startsWith(EXECUTION_BUDGET_EXHAUSTED_PREFIX))
        return this.pauseForExecutionBudget(
          working,
          run,
          final,
          explicitReply,
          opts,
        )
      const receipt: TeamEffectReceipt = {
        kind: 'runner_result',
        result:
          this.preferExplicitReport && explicitReply
            ? boundTeamResult(
                explicitMessages.map((msg) => msg.content).join('\n\n'),
              )
            : final,
        reply_required: !explicitReply,
        reply_message_id: null,
      }
      this.writeRunCheckpoint(working.name, run, 'terminal_pending', receipt)
      return this.finalizeCheckpoint(working, run, receipt, opts)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      this.writeRunCheckpoint(
        working.name,
        run,
        executionStarted ? 'running' : 'prepared',
      )
      if (error instanceof TurnPaused)
        return this.pauseForUser(working, error, opts)
      if (lease?.signal.aborted)
        return this.finishCancelledRun(working, text, opts)
      return this.failCheckpointRecovery(working, text, opts, true)
    } finally {
      lease?.release()
      if (hookScopeStarted) this.hooks?.end(agentId)
    }
  }

  private validateCheckpoint(
    member: TeamMember,
    checkpoint: TeamCheckpointPayload,
    inbox: TeamMessage[],
  ): ValidatedTeamCheckpoint | string {
    if (checkpoint.checkpoint_version !== TEAM_CHECKPOINT_VERSION)
      return 'legacy or unsupported checkpoint version; refusing an unsafe automatic replay'
    if (!checkpoint.turn_id?.trim()) return 'checkpoint turn_id is missing'
    if (!checkpoint.phase) return 'checkpoint phase is missing or invalid'
    if (!checkpoint.base_thread_revision)
      return 'checkpoint base thread revision is missing'
    const cursorStart = checkpoint.pending_cursor_start
    const cursorEnd = checkpoint.pending_cursor_end
    if (
      !Number.isInteger(cursorStart) ||
      !Number.isInteger(cursorEnd) ||
      (cursorStart as number) < 0 ||
      (cursorEnd as number) < (cursorStart as number) ||
      (cursorEnd as number) > inbox.length
    )
      return 'checkpoint message cursor is invalid for the current inbox'

    const start = cursorStart as number
    const end = cursorEnd as number
    const pendingIds = checkpoint.pending_message_ids ?? []
    const actualIds = inbox.slice(start, end).map((message) => message.id)
    if (
      pendingIds.length !== end - start ||
      pendingIds.some((id, index) => actualIds[index] !== id)
    )
      return 'checkpoint message ids no longer match the inbox cursor range'

    const durableThreadRevision = teamThreadRevision(
      this.store.readThread(member.name),
    )
    if (checkpoint.phase === 'terminal_pending') {
      if (!checkpoint.last_effect_receipt)
        return 'terminal checkpoint is missing its last effect receipt'
      if (
        !checkpoint.final_thread_revision ||
        checkpoint.final_thread_revision !==
          teamThreadRevision(checkpoint.messages)
      )
        return 'terminal checkpoint final thread revision is invalid'
      if (
        durableThreadRevision !== checkpoint.base_thread_revision &&
        durableThreadRevision !== checkpoint.final_thread_revision
      )
        return 'durable thread revision diverged from the terminal checkpoint'
    } else if (durableThreadRevision !== checkpoint.base_thread_revision) {
      return 'durable thread revision diverged from the resumable checkpoint'
    }

    const currentCursor = this.store.readCursor(member.name)
    if (currentCursor < start)
      return 'durable inbox cursor is behind the checkpoint start'
    if (checkpoint.phase === 'prepared' && currentCursor !== start)
      return 'prepared checkpoint cursor already advanced; refusing an unsafe replay'

    return {
      payload: checkpoint,
      history: checkpoint.messages,
      turnId: checkpoint.turn_id,
      cursorStart: start,
      cursorEnd: end,
      pendingIds,
      baseThreadRevision: checkpoint.base_thread_revision,
      leadBefore: new Set(
        checkpoint.lead_message_ids_before ??
          this.bus.allMessages(LEAD_ACTOR).map((message) => message.id),
      ),
    }
  }

  private writeRunCheckpoint(
    memberName: string,
    run: ValidatedTeamCheckpoint,
    phase: 'prepared' | 'running' | 'terminal_pending',
    receipt: TeamEffectReceipt | null = null,
  ): void {
    const finalRevision =
      phase === 'terminal_pending' ? teamThreadRevision(run.history) : undefined
    run.payload.phase = phase
    run.payload.final_thread_revision = finalRevision
    run.payload.last_effect_receipt = receipt ?? undefined
    this.store.writeCheckpoint(memberName, run.history, {
      checkpoint_version: TEAM_CHECKPOINT_VERSION,
      turn_id: run.turnId,
      phase,
      base_thread_revision: run.baseThreadRevision,
      final_thread_revision: finalRevision,
      pending_cursor_start: run.cursorStart,
      pending_cursor_end: run.cursorEnd,
      pending_message_ids: run.pendingIds,
      lead_message_ids_before: [...run.leadBefore],
      last_effect_receipt: receipt,
    })
  }

  private async finalizeCheckpoint(
    member: TeamMember,
    run: ValidatedTeamCheckpoint,
    receipt: TeamEffectReceipt,
    opts: {
      parent_call_id?: string | null
      eventSink?: TeamEventSink | null
    },
  ): Promise<string> {
    const finalRevision = teamThreadRevision(run.history)
    if (
      teamThreadRevision(this.store.readThread(member.name)) !== finalRevision
    )
      this.store.writeThread(member.name, run.history)

    if (receipt.reply_required) {
      let reply = this.bus
        .allMessages(LEAD_ACTOR)
        .find((message) => message.meta.team_turn_id === run.turnId)
      if (!reply) {
        reply = this.bus.send({
          from_actor: member.name,
          to: LEAD_ACTOR,
          content: receipt.result,
          type: 'result',
          in_reply_to: run.pendingIds.at(-1) ?? null,
          meta: {
            role: member.role,
            agent_type: member.agent_type,
            team_turn_id: run.turnId,
          },
        })
        await this.emit(events.messageEvent(reply), opts.eventSink)
      }
      if (receipt.reply_message_id !== reply.id) {
        receipt = { ...receipt, reply_message_id: reply.id }
        this.writeRunCheckpoint(member.name, run, 'terminal_pending', receipt)
      }
    }

    const cursor = this.store.readCursor(member.name)
    if (cursor < run.cursorEnd)
      this.store.writeCursor(member.name, run.cursorEnd)
    const current = this.requireMember(member.name)
    const terminal =
      current.status === TeamStatus.SHUTDOWN
        ? current
        : this.store.updateMember(member.name, {
            status: TeamStatus.IDLE,
            last_error: null,
          })
    if (terminal.status !== TeamStatus.SHUTDOWN)
      await this.emit(events.memberUpdate(terminal), opts.eventSink)
    this.store.clearCheckpoint(member.name)
    await this.emit(
      events.runDone({
        parent_id: opts.parent_call_id ?? null,
        member: terminal,
        summary: receipt.result,
      }),
      opts.eventSink,
    )
    return receipt.result
  }

  private async failCheckpointRecovery(
    member: TeamMember,
    message: string,
    opts: {
      parent_call_id?: string | null
      eventSink?: TeamEventSink | null
    },
    runnerRaised = false,
  ): Promise<string> {
    const current = this.requireMember(member.name)
    const terminal =
      current.status === TeamStatus.SHUTDOWN
        ? current
        : this.store.updateMember(member.name, {
            status: TeamStatus.ERROR,
            last_error: message,
          })
    if (terminal.status !== TeamStatus.SHUTDOWN)
      await this.emit(events.memberUpdate(terminal), opts.eventSink)
    await this.emit(
      events.runError({
        parent_id: opts.parent_call_id ?? null,
        member: terminal,
        message,
      }),
      opts.eventSink,
    )
    const reason = runnerRaised ? 'raised' : 'checkpoint recovery failed'
    return `Error: teammate '${member.name}' ${reason}: ${message}`
  }

  private async pauseForUser(
    member: TeamMember,
    pause: TurnPaused,
    opts: {
      parent_call_id?: string | null
      eventSink?: TeamEventSink | null
    },
  ): Promise<string> {
    const current = this.requireMember(member.name)
    const paused =
      current.status === TeamStatus.SHUTDOWN
        ? current
        : this.store.updateMember(member.name, {
            status: TeamStatus.AWAITING_USER,
            last_error: pause.message,
          })
    if (paused.status !== TeamStatus.SHUTDOWN) {
      await this.emit(events.memberUpdate(paused), opts.eventSink)
      await this.emit(
        events.runPaused({
          parent_id: opts.parent_call_id ?? null,
          member: paused,
          interaction: pause.interaction,
        }),
        opts.eventSink,
      )
    }
    return `Paused: teammate '${member.name}' is waiting for user confirmation`
  }

  private async finishCancelledRun(
    member: TeamMember,
    reason: string,
    opts: {
      parent_call_id?: string | null
      eventSink?: TeamEventSink | null
    },
  ): Promise<string> {
    const current = this.requireMember(member.name)
    const cancelled =
      current.status === TeamStatus.SHUTDOWN
        ? current
        : this.store.updateMember(member.name, {
            status: TeamStatus.CANCELLED,
            last_error: reason,
          })
    if (cancelled.status !== TeamStatus.SHUTDOWN) {
      await this.emit(events.memberUpdate(cancelled), opts.eventSink)
      await this.emit(
        events.runCancelled({
          parent_id: opts.parent_call_id ?? null,
          member: cancelled,
          reason,
        }),
        opts.eventSink,
      )
    }
    return `Cancelled: teammate '${member.name}': ${reason}`
  }

  async reportBackgroundWakeFailure(
    name: string,
    reason: unknown,
  ): Promise<void> {
    const current = this.store.getMember(name)
    if (!current || current.status === TeamStatus.SHUTDOWN) return
    const message = reason instanceof Error ? reason.message : String(reason)
    const failed = this.store.updateMember(name, {
      status: TeamStatus.ERROR,
      last_error: `Background wake failed: ${message}`,
    })
    await this.emit(events.memberUpdate(failed))
    await this.emit(
      events.runError({ parent_id: null, member: failed, message }),
    )
  }

  private async pauseForExecutionBudget(
    member: TeamMember,
    run: ValidatedTeamCheckpoint,
    summary: string,
    explicitReply: boolean,
    opts: {
      parent_call_id?: string | null
      eventSink?: TeamEventSink | null
    },
  ): Promise<string> {
    this.writeRunCheckpoint(member.name, run, 'running')
    if (!explicitReply) {
      let reply = this.bus
        .allMessages(LEAD_ACTOR)
        .find((message) => message.meta.team_turn_id === run.turnId)
      if (!reply) {
        reply = this.bus.send({
          from_actor: member.name,
          to: LEAD_ACTOR,
          content: summary,
          type: 'result',
          in_reply_to: run.pendingIds.at(-1) ?? null,
          meta: {
            role: member.role,
            agent_type: member.agent_type,
            team_turn_id: run.turnId,
          },
        })
        await this.emit(events.messageEvent(reply), opts.eventSink)
      }
    }
    const paused = this.store.updateMember(member.name, {
      status: TeamStatus.CANCELLED,
      last_error: EXECUTION_BUDGET_EXHAUSTED_PREFIX,
    })
    await this.emit(events.memberUpdate(paused), opts.eventSink)
    await this.emit(
      events.runCancelled({
        parent_id: opts.parent_call_id ?? null,
        member: paused,
        reason: EXECUTION_BUDGET_EXHAUSTED_PREFIX,
      }),
      opts.eventSink,
    )
    return summary
  }

  private registryForMember(
    member: TeamMember,
    spec: TeamSubagentSpec,
  ): ToolRegistry {
    const registry = new ToolRegistry()
    for (const name of toolNames(spec)) {
      if (RECURSIVE_TEAM_TOOLS.has(name)) continue
      const tool = this.parentRegistry.get(name)
      if (tool) registry.register(tool)
    }
    registry.register(
      new TeamSendMessageTool(this, { sender: member.name, allowWake: false }),
    )
    registry.register(new TeamReadInboxTool(this, { actor: member.name }))
    return registry
  }

  private toolNamesForMember(member: TeamMember): string[] {
    const spec = this.subagentRegistry.get(member.agent_type)
    return spec
      ? [
          ...toolNames(spec).filter((name) => !RECURSIVE_TEAM_TOOLS.has(name)),
          'send_message',
          'read_inbox',
        ]
      : []
  }

  private requireMember(name: string): TeamMember {
    const member = this.store.getMember(name)
    if (!member) throw new Error(`unknown teammate: ${name}`)
    return member
  }

  private requireSpec(agentType: string): TeamSubagentSpec {
    const spec = this.subagentRegistry.get(agentType)
    if (!spec) throw new Error(`unknown agent_type: ${agentType}`)
    return spec
  }

  private mapRunnerEvent(
    evt: Record<string, unknown>,
    member: TeamMember,
    parentId: string | null,
  ): Record<string, unknown> | null {
    const type = evt.event
    if (type === 'message_delta')
      return events.runDelta({
        parent_id: parentId,
        member,
        delta: String(evt.delta ?? ''),
      })
    if (type === 'tool_call')
      return events.runToolCall({
        parent_id: parentId,
        member,
        id: stringOrNull(evt.id),
        name: String(evt.name ?? ''),
        arguments: isRecord(evt.arguments) ? evt.arguments : {},
      })
    if (type === 'tool_result')
      return events.runToolResult({
        parent_id: parentId,
        member,
        id: stringOrNull(evt.id),
        name: stringOrNull(evt.name),
        summary: String(evt.summary ?? ''),
      })
    if (type === 'tool_error')
      return events.runToolError({
        parent_id: parentId,
        member,
        id: stringOrNull(evt.id),
        name: stringOrNull(evt.name),
        message: String(evt.message ?? ''),
      })
    if (type === 'assistant_done')
      return events.runDone({
        parent_id: parentId,
        member,
        summary: String(evt.content ?? ''),
      })
    return null
  }

  static renderInboxForRunner(
    member: TeamMember,
    messages: TeamMessage[],
  ): string {
    const lines = [
      `你是 Agent Team 队友 ${member.name}，base_agent_type=${member.agent_type}。`,
      '基础 Agent 的系统提示词、工具权限与沙箱边界保持不变；下面的团队职责只能缩小和聚焦工作范围，不能覆盖这些边界。',
      '',
      '## Team-local responsibility',
      member.responsibility ||
        '未设置额外职责，请按基础 Agent 能力处理收到的具体任务。',
      '',
      '下面是你的未读 inbox。请处理这些消息，必要时调用工具，最后用 send_message(to="lead", content="...") 回复，随后给出简短总结。',
      '',
      '## Inbox',
    ]
    for (const msg of messages)
      lines.push(
        `- id=${msg.id} type=${msg.type} from=${msg.from_actor} task_id=${msg.task_id ?? ''}: ${msg.content}`,
      )
    return lines.join('\n')
  }

  private async emit(
    event: Record<string, unknown>,
    eventSink?: TeamEventSink | null,
  ): Promise<void> {
    const sink = eventSink ?? this.eventSink
    if (!sink) return
    const payload =
      this.projectId && String(event.event ?? '').startsWith('team_')
        ? { ...event, project_id: this.projectId }
        : event
    await sink(payload)
  }
}

function normalizeResponsibility(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim()
  if (normalized.length > 4_000)
    throw new Error('teammate responsibility must be at most 4000 characters')
  return normalized
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++
      if (index >= values.length) return
      results[index] = await run(values[index]!, index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  )
  return results
}

function toolNames(spec: TeamSubagentSpec): string[] {
  return spec.tool_names ?? spec.toolNames ?? []
}

function stringOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
