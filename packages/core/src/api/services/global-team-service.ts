import { GlobalTeamCatalog } from '../../team/catalog'
import type {
  CreateGlobalTeamInput,
  GlobalTeamPayload,
  TeamConversationPayload,
  TeamWorkspaceBinding,
  TeamRunPayload,
  TeamRunAssignment,
} from '../../team/domain'
import type { TeamManager } from '../../team/manager'
import { EXECUTION_BUDGET_EXHAUSTED_PREFIX } from '../../agent/runner-helpers'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const GLOBAL_TEAM_MEMBER_PARALLELISM = 2
const PRIMARY_EVIDENCE_MARKER = '\n\n[Team primary evidence]\n'

export interface CoreGlobalTeamServiceDeps {
  captureExecution?: () => {
    modelLabel: string
    createManager: NonNullable<CoreGlobalTeamServiceDeps['createManager']>
    synthesize: NonNullable<CoreGlobalTeamServiceDeps['synthesize']>
  }
  catalog: GlobalTeamCatalog
  availableAgentTypes: () => string[]
  assertMutation?: (area: string, action: string) => void
  createManager?: (opts: {
    runtimeRoot: string
    workspaceRoot: string
    runtimeScopeId: string
    sessionId: string
  }) => TeamManager
  synthesize?: (opts: {
    prompt: string
    workspaceRoot: string
    signal?: AbortSignal | null
  }) => Promise<string>
  resolveProjectPath?: (projectId: string) => string | null
}

export interface CoreGlobalTeamListItem extends GlobalTeamPayload {
  latest_conversation: TeamConversationPayload | null
  conversation_count: number
}

export interface CoreGlobalTeamDetail {
  team: GlobalTeamPayload
  conversations: TeamConversationPayload[]
}

/**
 * Core boundary for the new global Team domain.
 *
 * Global Teams do not depend on the currently active chat session and never
 * touch the legacy project TeamManager. Each Team conversation owns an isolated
 * runtime and a stable synthetic control session used by permission/HITL flows.
 */
export class CoreGlobalTeamService {
  private readonly admitting = new Set<string>()
  private readonly executions = new Map<
    string,
    ReturnType<NonNullable<CoreGlobalTeamServiceDeps['captureExecution']>>
  >()
  private readonly active = new Map<string, AbortController>()
  constructor(private readonly deps: CoreGlobalTeamServiceDeps) {}

  async list(): Promise<CoreGlobalTeamListItem[]> {
    const teams = await this.deps.catalog.listTeams()
    return Promise.all(
      teams.map(async (team) => {
        const conversations = await this.deps.catalog.listConversations(team.id)
        return {
          ...team,
          latest_conversation: conversations[0] ?? null,
          conversation_count: conversations.length,
        }
      }),
    )
  }

  async get(teamId: string): Promise<CoreGlobalTeamDetail> {
    const team = await this.deps.catalog.getTeam(teamId)
    if (!team) throw new Error(`unknown team: ${teamId}`)
    return {
      team,
      conversations: await this.deps.catalog.listConversations(team.id),
    }
  }

  async create(input: CreateGlobalTeamInput): Promise<CoreGlobalTeamDetail> {
    this.deps.assertMutation?.('teams', 'create global team')
    this.assertAgentTypes(input.members.map((member) => member.agent_type))
    const created = await this.deps.catalog.createTeam(input)
    return { team: created.team, conversations: [created.conversation] }
  }

  async listConversations(teamId: string): Promise<TeamConversationPayload[]> {
    const team = await this.deps.catalog.getTeam(teamId)
    if (!team) throw new Error(`unknown team: ${teamId}`)
    return this.deps.catalog.listConversations(team.id)
  }

  async createConversation(
    teamId: string,
    input: { title: string; workspace?: TeamWorkspaceBinding | null },
  ): Promise<TeamConversationPayload> {
    this.deps.assertMutation?.('teams', 'create team conversation')
    return this.deps.catalog.createConversation(teamId, input)
  }

  async listRuns(
    teamId: string,
    conversationId: string,
  ): Promise<TeamRunPayload[]> {
    if (!this.admitting.has(`${teamId}:${conversationId}`))
      await this.reconcileConversation(teamId, conversationId)
    return this.deps.catalog.listRuns(teamId, conversationId)
  }

  async submit(
    teamId: string,
    conversationId: string,
    message: string,
  ): Promise<TeamRunPayload> {
    const key = `${teamId}:${conversationId}`
    if (this.admitting.has(key))
      throw new Error('正在提交团队任务，请勿重复操作。')
    this.admitting.add(key)
    try {
      return await this.submitAccepted(teamId, conversationId, message)
    } finally {
      this.admitting.delete(key)
    }
  }

  private async submitAccepted(
    teamId: string,
    conversationId: string,
    message: string,
  ): Promise<TeamRunPayload> {
    this.deps.assertMutation?.('teams', 'submit team task')
    if (
      !this.deps.captureExecution &&
      (!this.deps.createManager || !this.deps.synthesize)
    )
      throw new Error('global Team execution is unavailable')
    await this.reconcileConversation(teamId, conversationId)
    const existing = (
      await this.deps.catalog.listRuns(teamId, conversationId)
    ).find((item) => !isTerminal(item.state))
    if (existing)
      throw new Error('this Team conversation already has an active task')
    const execution = this.deps.captureExecution?.()
    const run = await this.deps.catalog.createRun(
      teamId,
      conversationId,
      message,
    )
    const controller = new AbortController()
    if (execution) {
      this.executions.set(run.id, execution)
      run.model_label = execution.modelLabel
      await this.patchRun(run, (current) => ({
        ...current,
        model_label: execution.modelLabel,
      }))
    }
    this.active.set(run.id, controller)
    void this.execute(run, controller).finally(() =>
      this.releaseActiveRun(run, controller),
    )
    return run
  }

  async resume(
    teamId: string,
    conversationId: string,
    runId: string,
  ): Promise<TeamRunPayload> {
    this.deps.assertMutation?.('teams', 'resume team task')
    const run = await this.deps.catalog.getRun(teamId, conversationId, runId)
    if (!run) throw new Error(`unknown team run: ${runId}`)
    if (run.state !== 'awaiting_user')
      throw new Error('Team task is not awaiting user confirmation')
    if (this.active.has(run.id)) return run
    const controller = new AbortController()
    this.active.set(run.id, controller)
    void this.execute(run, controller, true).finally(() =>
      this.releaseActiveRun(run, controller),
    )
    return run
  }

  async retry(
    teamId: string,
    conversationId: string,
    runId: string,
  ): Promise<TeamRunPayload> {
    this.deps.assertMutation?.('teams', 'retry failed team members')
    const key = `${teamId}:${conversationId}`
    if (this.admitting.has(key))
      throw new Error('正在提交团队任务，请勿重复操作。')
    this.admitting.add(key)
    try {
      const previous = await this.deps.catalog.getRun(
        teamId,
        conversationId,
        runId,
      )
      if (!previous || !['partial', 'failed'].includes(previous.state))
        throw new Error('只能重试已结束且未完成的任务。')
      if (
        (await this.listRuns(teamId, conversationId)).some(
          (run) => !isTerminal(run.state),
        )
      )
        throw new Error('当前对话已有执行中的任务。')
      const execution = this.deps.captureExecution?.()
      let run = await this.deps.catalog.createRun(
        teamId,
        conversationId,
        previous.user_message,
      )
      run = await this.patchRun(run, (current) => ({
        ...current,
        retry_of_run_id: previous.id,
        members: previous.members,
        workspace: previous.workspace,
        assignments: previous.assignments.map((item) => {
          const reviewer =
            previous.members.find((member) => member.id === item.member_id)
              ?.agent_type === 'verification_reviewer'
          return item.status === 'completed' && !reviewer
            ? item
            : {
                ...item,
                task: item.task.split(PRIMARY_EVIDENCE_MARKER)[0]!,
                status: 'pending',
                dispatched: false,
                result: '',
                error: '',
                started_at: null,
                finished_at: null,
              }
        }),
      }))
      if (execution) {
        this.executions.set(run.id, execution)
        run = await this.patchRun(run, (current) => ({
          ...current,
          model_label: execution.modelLabel,
        }))
      }
      const controller = new AbortController()
      this.active.set(run.id, controller)
      void this.execute(run, controller).finally(() =>
        this.releaseActiveRun(run, controller),
      )
      return run
    } finally {
      this.admitting.delete(key)
    }
  }

  async cancel(
    teamId: string,
    conversationId: string,
    runId: string,
  ): Promise<TeamRunPayload> {
    this.deps.assertMutation?.('teams', 'cancel team task')
    this.active.get(runId)?.abort(new Error('Team task cancelled by user'))
    const current = await this.deps.catalog.getRun(
      teamId,
      conversationId,
      runId,
    )
    if (!current) throw new Error(`unknown team run: ${runId}`)
    if (isTerminal(current.state)) return current
    return this.deps.catalog.updateRun(
      teamId,
      conversationId,
      runId,
      (run) => ({
        ...run,
        state: 'cancelled',
        finished_at: Date.now() / 1000,
        assignments: run.assignments.map((item) =>
          item.status === 'completed' || item.status === 'failed'
            ? item
            : { ...item, status: 'cancelled' },
        ),
      }),
    )
  }

  private async execute(
    initial: TeamRunPayload,
    controller: AbortController,
    resume = false,
  ): Promise<void> {
    const { team_id: teamId, conversation_id: conversationId } = initial
    try {
      const workspaceRoot = await this.workspaceRoot(initial)
      const execution =
        this.executions.get(initial.id) ?? this.deps.captureExecution?.()
      if (
        execution &&
        initial.model_label &&
        execution.modelLabel !== initial.model_label
      )
        throw new Error('本次任务的模型配置已变化，请切回原模型后继续。')
      if (execution) this.executions.set(initial.id, execution)
      const manager = (execution?.createManager ?? this.deps.createManager!)({
        runtimeRoot: initial.retry_of_run_id
          ? join(
              this.deps.catalog.runtimeDir(teamId, conversationId),
              initial.id,
            )
          : this.deps.catalog.runtimeDir(teamId, conversationId),
        workspaceRoot,
        runtimeScopeId: `team-conversation:${conversationId}`,
        sessionId: teamControlSessionId(conversationId),
      })
      const assignments: TeamRunAssignment[] =
        (resume || initial.retry_of_run_id) && initial.assignments.length
          ? initial.assignments
          : initial.members.map((member) => ({
              member_id: member.id,
              task: memberTask(initial, member),
              status: 'pending',
              result: '',
              error: '',
              dispatched: false,
            }))
      if (!resume)
        await this.patchRun(initial, (run) => ({
          ...run,
          state: 'planning',
          started_at: Date.now() / 1000,
          assignments,
        }))
      for (const member of initial.members) {
        await manager.spawnTeammate({
          name: member.id,
          role: member.display_name,
          responsibility: member.responsibility,
          agent_type: member.agent_type,
        })
      }
      await this.patchRun(initial, (run) => ({
        ...run,
        state: 'running',
        assignments: run.assignments.map((item) =>
          (resume || initial.retry_of_run_id) && item.status !== 'pending'
            ? item
            : { ...item, status: 'pending' },
        ),
      }))

      const byMember = new Map(
        assignments.map((item) => [item.member_id, item]),
      )
      const primaryMembers = initial.members.filter(
        (member) => member.agent_type !== 'verification_reviewer',
      )
      const reviewMembers = initial.members.filter(
        (member) => member.agent_type === 'verification_reviewer',
      )
      const firstPhase = primaryMembers.length ? primaryMembers : reviewMembers
      const secondPhase = primaryMembers.length ? reviewMembers : []
      await this.executeMemberPhase({
        initial,
        manager,
        members: firstPhase,
        assignments: byMember,
        controller,
        resume,
        sessionId: teamControlSessionId(conversationId),
      })
      if (controller.signal.aborted) return

      const primaryPaused = firstPhase.some(
        (member) => byMember.get(member.id)?.status === 'pending',
      )
      if (!primaryPaused && secondPhase.length) {
        const evidence = assignmentEvidence(
          initial,
          [...byMember.values()].filter((item) =>
            firstPhase.some((member) => member.id === item.member_id),
          ),
        )
        for (const member of secondPhase) {
          const assignment = byMember.get(member.id)
          if (!assignment || (resume && assignment.status !== 'pending'))
            continue
          if (!assignment.task.includes(PRIMARY_EVIDENCE_MARKER)) {
            assignment.task = `${assignment.task}${PRIMARY_EVIDENCE_MARKER}以下是先行成员的结果，请据此进行独立复核；不要假装看到了未提供的证据：\n\n${evidence}`
          }
        }
        await this.executeMemberPhase({
          initial,
          manager,
          members: secondPhase,
          assignments: byMember,
          controller,
          resume,
          sessionId: teamControlSessionId(conversationId),
        })
      }
      if (controller.signal.aborted) return

      const completed = assignments.map(
        (assignment) => byMember.get(assignment.member_id) ?? assignment,
      )
      if (completed.some((item) => item.status === 'pending')) {
        await this.patchRun(initial, (run) => ({
          ...run,
          state: 'awaiting_user',
          assignments: completed,
        }))
        return
      }
      const successes = completed.filter((item) => item.status === 'completed')
      if (!successes.length) {
        const evidence = assignmentEvidence(initial, completed)
        await this.patchRun(initial, (run) => ({
          ...run,
          state: 'failed',
          assignments: completed,
          final_response: `团队任务未完成：所有成员均执行失败。\n\n${evidence}`,
          error: '所有 Team 成员均执行失败',
          finished_at: Date.now() / 1000,
        }))
        return
      }
      await this.patchRun(initial, (run) => ({
        ...run,
        state: 'synthesizing',
        assignments: completed,
      }))
      const evidence = assignmentEvidence(initial, completed)
      let final: string
      let synthesisError = ''
      try {
        final = await (execution?.synthesize ?? this.deps.synthesize!)({
          workspaceRoot,
          signal: controller.signal,
          prompt: [
            `用户任务：\n${initial.user_message}`,
            `队友结果：\n${evidence}`,
            [
              '请综合为最终答复，并遵守以下要求：',
              '1. 逐份阅读并覆盖所有已完成的成员报告，不得只采用其中一份。',
              '2. 区分已验证事实、成员建议和未验证推断。',
              '3. 有分歧、失败或缺少证据时必须明确说明，不得自行补齐。',
              '4. 优先直接回答用户任务，不要声称多 Agent 协作本身等于结果正确。',
            ].join('\n'),
          ].join('\n\n'),
        })
      } catch (error) {
        if (controller.signal.aborted) return
        synthesisError = `协调汇总失败：${errorText(error)}`
        final = `团队成员已完成工作，但自动汇总失败。以下是成员原始结果：\n\n${evidence}`
      }
      if (controller.signal.aborted) return
      await this.patchRun(initial, (run) => ({
        ...run,
        state:
          successes.length === completed.length && !synthesisError
            ? 'completed'
            : 'partial',
        assignments: completed,
        final_response: final,
        error: synthesisError,
        finished_at: Date.now() / 1000,
      }))
    } catch (error) {
      if (controller.signal.aborted) return
      await this.patchRun(initial, (run) =>
        isTerminal(run.state)
          ? run
          : {
              ...run,
              state: 'failed',
              error: errorText(error),
              finished_at: Date.now() / 1000,
            },
      ).catch(() => {})
    }
  }

  private async executeMemberPhase(opts: {
    initial: TeamRunPayload
    manager: TeamManager
    members: TeamRunPayload['members']
    assignments: Map<string, TeamRunAssignment>
    controller: AbortController
    resume: boolean
    sessionId: string
  }): Promise<void> {
    const runnable = opts.members.filter((member) => {
      const assignment = opts.assignments.get(member.id)
      return (
        assignment &&
        assignment.status !== 'completed' &&
        (!opts.resume || assignment.status === 'pending')
      )
    })
    for (
      let offset = 0;
      offset < runnable.length;
      offset += GLOBAL_TEAM_MEMBER_PARALLELISM
    ) {
      const batch = runnable.slice(
        offset,
        offset + GLOBAL_TEAM_MEMBER_PARALLELISM,
      )
      const alreadyDispatched = new Set(
        batch
          .filter((member) => opts.assignments.get(member.id)?.dispatched)
          .map((member) => member.id),
      )
      for (const member of batch) {
        const assignment = opts.assignments.get(member.id)!
        assignment.status = 'running'
        assignment.started_at = Date.now() / 1000
        assignment.finished_at = null
        assignment.error = ''
        assignment.dispatched = true
      }
      await this.patchRun(opts.initial, (run) => ({
        ...run,
        state: 'running',
        assignments: run.assignments.map(
          (item) => opts.assignments.get(item.member_id) ?? item,
        ),
      }))

      await Promise.all(
        batch.map(async (member) => {
          const assignment = opts.assignments.get(member.id)!
          try {
            let result: string
            if (opts.resume && alreadyDispatched.has(member.id)) {
              result = await opts.manager.wakeTeammate(member.id, {
                recovery: 'retry',
                signal: opts.controller.signal,
                session_id: opts.sessionId,
              })
            } else {
              const raw = await opts.manager.sendMessage({
                to: member.id,
                content: assignment.task,
                type: 'task',
                wake: true,
                signal: opts.controller.signal,
                session_id: opts.sessionId,
              })
              const parsed = JSON.parse(raw) as { result?: unknown }
              result = String(parsed.result ?? '')
            }
            Object.assign(assignment, memberResult(result))
          } catch (error) {
            assignment.status = 'failed'
            assignment.result = ''
            assignment.error = errorText(error)
          }
          assignment.finished_at = Date.now() / 1000
          if (opts.controller.signal.aborted) return
          await this.patchRun(opts.initial, (run) =>
            isTerminal(run.state)
              ? run
              : {
                  ...run,
                  assignments: run.assignments.map((item) =>
                    item.member_id === member.id ? { ...assignment } : item,
                  ),
                },
          )
        }),
      )
      if (opts.controller.signal.aborted) return
      if (
        batch.some(
          (member) => opts.assignments.get(member.id)?.status === 'pending',
        )
      )
        return
    }
  }

  private async reconcileConversation(
    teamId: string,
    conversationId: string,
  ): Promise<void> {
    const runs = await this.deps.catalog.listRuns(teamId, conversationId)
    for (const run of runs) {
      if (
        isTerminal(run.state) ||
        this.active.has(run.id) ||
        run.state === 'awaiting_user'
      )
        continue
      await this.deps.catalog.updateRun(
        teamId,
        conversationId,
        run.id,
        (current) => {
          // The list above is only a snapshot. Execution can persist a pause or
          // terminal state while this reconciliation is waiting for the store
          // lock, so re-check the current record before declaring it orphaned.
          if (
            isTerminal(current.state) ||
            current.state === 'awaiting_user' ||
            this.active.has(current.id)
          )
            return current
          return {
            ...current,
            state: 'failed',
            error:
              '应用在任务执行期间退出。为避免重复执行有副作用的操作，本次任务未自动重放。',
            finished_at: Date.now() / 1000,
          }
        },
      )
    }
  }

  private async workspaceRoot(run: TeamRunPayload): Promise<string> {
    const runtimeRoot = this.deps.catalog.runtimeDir(
      run.team_id,
      run.conversation_id,
    )
    if (run.workspace.kind === 'folder') return resolve(run.workspace.path)
    if (run.workspace.kind === 'project') {
      const path =
        run.workspace.path ||
        this.deps.resolveProjectPath?.(run.workspace.project_id)
      if (!path)
        throw new Error(
          `unknown Team workspace project: ${run.workspace.project_id}`,
        )
      return resolve(path)
    }
    const isolated = join(runtimeRoot, 'workspace')
    await mkdir(isolated, { recursive: true })
    return isolated
  }

  private patchRun(
    run: TeamRunPayload,
    mutate: (current: TeamRunPayload) => TeamRunPayload,
  ): Promise<TeamRunPayload> {
    return this.deps.catalog.updateRun(
      run.team_id,
      run.conversation_id,
      run.id,
      (current) => (isTerminal(current.state) ? current : mutate(current)),
    )
  }

  private releaseActiveRun(
    initial: TeamRunPayload,
    controller: AbortController,
  ): void {
    const runId = initial.id
    if (this.active.get(runId) === controller) this.active.delete(runId)
    void this.deps.catalog
      .getRun(initial.team_id, initial.conversation_id, runId)
      .then((run) => {
        if (run && isTerminal(run.state)) this.executions.delete(runId)
      })
      .catch(() => {})
  }

  private assertAgentTypes(agentTypes: string[]): void {
    const available = new Set(this.deps.availableAgentTypes())
    for (const agentType of agentTypes) {
      if (!available.has(agentType))
        throw new Error(`unknown Team base agent type: ${agentType}`)
    }
  }
}

function isTerminal(state: TeamRunPayload['state']): boolean {
  return ['completed', 'partial', 'cancelled', 'failed'].includes(state)
}

function memberTask(
  run: TeamRunPayload,
  member: TeamRunPayload['members'][number],
): string {
  const reviewing = member.agent_type === 'verification_reviewer'
  return [
    `本次你是「${member.display_name}」，成员 ID：${member.id}，基础角色：${member.agent_type}。`,
    '只完成用户任务中分配给你的部分，不承担其他成员的职责。以下职责是默认工作方向；本次用户明确限定的范围应优先遵守，但不能扩大基础权限。',
    reviewing
      ? '你在复核阶段；依据附带的先行成员证据复核，缺失证据要如实说明，不轮询收件箱等待未来消息。'
      : '你在先行阶段；独立提交本职责的结果，不等待复核成员或其他先行成员。后续复核由系统调度。',
    `默认职责：${member.responsibility || '按基础角色完成分配部分'}`,
    '团队成员：' +
      run.members
        .map((item) => `${item.display_name}（${item.agent_type}）`)
        .join('、'),
    `\n用户任务：\n${run.user_message}`,
    '\n提交完整报告给 lead 后结束本轮。报告区分设计建议与已验证事实，不把工具成功或消息已发出当成业务验收通过。',
  ].join('\n')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function teamControlSessionId(conversationId: string): string {
  return `global-team:${conversationId}`
}

function memberResult(
  result: string,
): Pick<TeamRunAssignment, 'status' | 'result' | 'error'> {
  const text = String(result ?? '').trim()
  if (/^Cancelled:/i.test(text))
    return { status: 'cancelled', result: text, error: '' }
  if (!text || text === '没有未读消息。')
    return {
      status: 'failed',
      result: '',
      error: '成员未返回任务结果：任务可能未投递或消息已被消费。',
    }
  if (
    text.startsWith('Paused:') ||
    text.startsWith(EXECUTION_BUDGET_EXHAUSTED_PREFIX)
  )
    return { status: 'pending', result: text, error: '' }
  if (/^Error:\s*/i.test(text))
    return {
      status: 'failed',
      result: '',
      error: text.replace(/^Error:\s*/i, '').trim() || 'Team member failed',
    }
  return { status: 'completed', result: text, error: '' }
}

function assignmentEvidence(
  run: TeamRunPayload,
  assignments: TeamRunAssignment[],
): string {
  return assignments
    .map((item) => {
      const member = run.members.find((entry) => entry.id === item.member_id)
      const name = member?.display_name ?? item.member_id
      if (item.status === 'failed') return `### ${name}\n失败：${item.error}`
      if (item.status === 'pending')
        return `### ${name}\n等待继续：${item.result}`
      return `### ${name}\n${item.result || '未返回内容'}`
    })
    .join('\n\n')
}
