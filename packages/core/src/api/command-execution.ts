import { randomUUID } from 'node:crypto'
import type { CommandExecutionContext } from '../commands/platform'
import type { CommandInvocationResult } from '../commands/types'
import type { ModelConfigPayload } from './services/model-service'

type ControlMode = 'ask_before_edit' | 'smart_auto' | 'full_access' | 'plan'

interface ActiveCommandTask {
  readonly id: string
  readonly kind: string
  readonly session_id: string | null
}

export interface CoreCommandExecutionDependencies {
  readonly reload: () => Promise<void>
  readonly clearSession: (input: {
    sessionId: string
    invocationId: string
  }) => Promise<{ session: unknown }>
  readonly compactSession: (input: {
    force: true
    sessionId: string
    instructions: string
  }) => Promise<unknown>
  readonly listActiveTasks: () => ActiveCommandTask[]
  readonly pauseGoal: (
    goalId: string,
    sessionId: string,
    reason?: string,
  ) => Promise<unknown>
  readonly cancelTask: (taskId: string) => unknown
  readonly cancelSessionRuntime: (sessionId: string) => boolean
  readonly renameSession: (
    sessionId: string,
    title: string,
  ) => Promise<{ title: string }>
  readonly getModelConfig: () => Promise<
    Pick<ModelConfigPayload, 'models' | 'current'>
  >
  readonly activateModel: (entryId: string) => Promise<unknown>
  readonly setReasoningEffort: (
    entryId: string,
    reasoningEffort: string,
  ) => Promise<unknown>
  readonly setPermissionMode: (mode: Exclude<ControlMode, 'plan'>) => unknown
  readonly getControl: () => {
    mode: string
    previous_mode?: string | null
  }
  readonly setControlMode: (mode: ControlMode) => Promise<unknown>
  readonly listGoals: (
    sessionId: string,
  ) => Promise<Array<{ id: string; status: string }>>
  readonly resumeGoal: (goalId: string, sessionId: string) => Promise<unknown>
  readonly cancelGoal: (
    goalId: string,
    reason: string,
    sessionId: string,
  ) => Promise<unknown>
  readonly startGoal: (outcome: string, sessionId: string) => Promise<unknown>
  readonly getSubagent: (name: string) => { toolNames: string[] } | null
  readonly subagentNames: () => string[]
  readonly submitPrompt: (input: {
    sessionId: string
    content: string
    displayContent: string
    clientMessageId: string
    turnId: string
    delivery: 'queue'
    source: 'command'
    requestedSkills: Array<{ name: string; source: 'slash' }>
    attachments: string[]
  }) => Promise<unknown>
}

export class CoreCommandExecutionService {
  constructor(
    private readonly dependencies: CoreCommandExecutionDependencies,
  ) {}

  async executeBuiltin(
    context: CommandExecutionContext,
  ): Promise<CommandInvocationResult> {
    const { descriptor, parsed, sessionId, invocationId } = context
    const name = descriptor.name
    const tail = parsed.args.join(' ').trim()

    if (name === 'reload') {
      await this.dependencies.reload()
      return completed(context, 'reloaded', '工作台状态已刷新。')
    }
    if (name === 'clear') {
      const result = await this.dependencies.clearSession({
        sessionId,
        invocationId,
      })
      return completed(context, 'session_transitioned', '已创建全新上下文。', {
        session: result.session as Record<string, unknown>,
        previousSessionId: sessionId,
      })
    }
    if (name === 'compact') {
      const result = await this.dependencies.compactSession({
        force: true,
        sessionId,
        instructions: tail,
      })
      return completed(context, 'compacted', '当前会话已压缩并保留摘要。', {
        result: result as Record<string, unknown>,
      })
    }
    if (name === 'copy')
      return completed(
        context,
        'copy_last_assistant',
        '已准备复制最后一条回复。',
      )
    if (name === 'stop') return await this.stop(context)
    if (name === 'rename' && tail) {
      const session = await this.dependencies.renameSession(sessionId, tail)
      return completed(
        context,
        'session_renamed',
        `会话已重命名为“${session.title}”。`,
        { session: session as unknown as Record<string, unknown> },
      )
    }
    if (name === 'model' && tail) return await this.activateModel(context, tail)
    if (name === 'effort' && tail)
      return await this.setReasoningEffort(context, tail)
    if (name === 'permissions' && tail)
      return this.setPermissions(context, tail)
    if (name === 'plan') return await this.executePlan(context)
    if (name === 'goal') return await this.executeGoal(context)
    if (name === 'continue') {
      const promptId = this.schedulePrompt(context, '继续执行')
      return { status: 'submitted', promptId }
    }
    if (descriptor.uiSurface) {
      return {
        status: 'opened',
        surface: descriptor.uiSurface,
        params: {
          rawArgs: parsed.args.join(' '),
          options: parsed.options,
          invokedName: parsed.name,
          commandId: descriptor.id,
        },
      }
    }
    return completed(context, 'completed', '命令已执行。')
  }

  async submitSkill(
    context: CommandExecutionContext,
  ): Promise<CommandInvocationResult> {
    const binding = context.descriptor.skill
    if (!binding)
      return {
        status: 'rejected',
        code: 'skill_binding_missing',
        message: 'Skill 命令绑定缺失。',
      }
    const task = context.parsed.args.join(' ').trim()
    let forkAgent = binding.agent
    if (binding.context === 'fork') {
      forkAgent =
        forkAgent ||
        (this.dependencies.getSubagent('quick_check')
          ? 'quick_check'
          : this.dependencies.subagentNames()[0] || null)
      const spec = forkAgent ? this.dependencies.getSubagent(forkAgent) : null
      if (!spec)
        return {
          status: 'rejected',
          code: 'skill_fork_agent_unavailable',
          message: 'Skill 指定的子代理不可用。',
        }
      const unsupportedTools = binding.allowedTools.filter(
        (tool) => !spec.toolNames.includes(tool),
      )
      if (unsupportedTools.length)
        return {
          status: 'rejected',
          code: 'skill_fork_tool_scope_invalid',
          message: `Skill 请求了子代理未获授权的工具：${unsupportedTools.join('、')}`,
        }
    }
    const content =
      binding.context === 'fork'
        ? `[CONTROL:SKILL_FORK]\nAgent: ${forkAgent}\nAllowed tools: ${binding.allowedTools.join(', ') || 'agent definition'}\nEffort: ${binding.effort || 'inherit'}\nTask: ${task || '按 Skill 默认流程执行'}`
        : task || '按 Skill 默认流程执行'
    const promptId = this.schedulePrompt(
      context,
      content,
      context.parsed.raw,
      binding.name,
    )
    return { status: 'submitted', promptId }
  }

  private async stop(
    context: CommandExecutionContext,
  ): Promise<CommandInvocationResult> {
    const tasks = this.dependencies
      .listActiveTasks()
      .filter((task) => task.session_id === context.sessionId)
    for (const task of tasks) {
      if (task.kind === 'goal')
        await this.dependencies.pauseGoal(
          task.id.replace(/^goal:/, ''),
          context.sessionId,
          'user_stop',
        )
      this.dependencies.cancelTask(task.id)
    }
    const actorCancelled = this.dependencies.cancelSessionRuntime(
      context.sessionId,
    )
    const cancelled = tasks.length > 0 || actorCancelled
    return completed(
      context,
      cancelled ? 'stop_requested' : 'nothing_running',
      cancelled ? '已请求停止当前任务。' : '当前没有正在运行的任务。',
    )
  }

  private async activateModel(
    context: CommandExecutionContext,
    requested: string,
  ): Promise<CommandInvocationResult> {
    const config = await this.dependencies.getModelConfig()
    const model = config.models.find(
      (item) => item.entryId === requested || item.modelId === requested,
    )
    if (!model)
      return {
        status: 'rejected',
        code: 'model_not_found',
        message: `找不到模型：${requested}`,
      }
    await this.dependencies.activateModel(model.entryId)
    return completed(
      context,
      'model_activated',
      `已切换到 ${model.effectiveDisplayName}。`,
    )
  }

  private async setReasoningEffort(
    context: CommandExecutionContext,
    effort: string,
  ): Promise<CommandInvocationResult> {
    const config = await this.dependencies.getModelConfig()
    if (!config.current)
      return {
        status: 'rejected',
        code: 'model_unavailable',
        message: '当前没有可用模型。',
      }
    await this.dependencies.setReasoningEffort(config.current.entryId, effort)
    return completed(context, 'effort_updated', `思考强度已切换为 ${effort}。`)
  }

  private setPermissions(
    context: CommandExecutionContext,
    requested: string,
  ): CommandInvocationResult {
    if (requested === 'status')
      return {
        status: 'opened',
        surface: 'permissions',
        params: {
          rawArgs: '',
          invokedName: context.parsed.name,
          commandId: context.descriptor.id,
        },
      }
    const mode =
      requested === 'ask'
        ? 'ask_before_edit'
        : requested === 'smart' || requested === 'edits'
          ? 'smart_auto'
          : requested === 'full' || requested === 'auto'
            ? 'full_access'
            : null
    if (!mode)
      return {
        status: 'rejected',
        code: 'invalid_permission_mode',
        message: '权限模式必须是 ask、smart 或 full。',
      }
    this.dependencies.setPermissionMode(mode)
    return completed(context, 'permission_mode_updated', '执行权限已更新。', {
      mode,
    })
  }

  private async executePlan(
    context: CommandExecutionContext,
  ): Promise<CommandInvocationResult> {
    const tail = context.parsed.args.join(' ').trim()
    const normalized = tail.toLowerCase()
    if (!tail || normalized === 'status' || normalized === 'open')
      return {
        status: 'opened',
        surface: 'plan',
        params: { action: normalized || 'open' },
      }
    if (normalized === 'on') {
      await this.dependencies.setControlMode('plan')
      return completed(context, 'plan_enabled', 'Plan 模式已开启。')
    }
    if (normalized === 'off') {
      const control = this.dependencies.getControl()
      const previous = control.previous_mode
      const restore =
        control.mode === 'plan' &&
        (previous === 'ask_before_edit' ||
          previous === 'smart_auto' ||
          previous === 'full_access')
          ? previous
          : 'smart_auto'
      await this.dependencies.setControlMode(restore)
      return completed(context, 'plan_disabled', 'Plan 模式已关闭。')
    }
    await this.dependencies.setControlMode('plan')
    const promptId = this.schedulePrompt(context, tail, context.parsed.raw)
    return { status: 'submitted', promptId }
  }

  private async executeGoal(
    context: CommandExecutionContext,
  ): Promise<CommandInvocationResult> {
    const oldAction = context.parsed.name.startsWith('goal-')
      ? context.parsed.name.slice('goal-'.length)
      : ''
    const explicitTail = context.parsed.args.join(' ').trim()
    const tail = oldAction
      ? `${oldAction}${explicitTail ? ` ${explicitTail}` : ''}`
      : explicitTail
    if (!tail || tail === 'status' || tail === 'list')
      return {
        status: 'opened',
        surface: 'goal',
        params: { action: tail || 'open' },
      }
    const goals = await this.dependencies.listGoals(context.sessionId)
    const active = goals.find(
      (goal) => goal.status !== 'completed' && goal.status !== 'cancelled',
    )
    if (tail === 'pause' || tail === 'resume' || tail === 'cancel') {
      if (!active)
        return {
          status: 'rejected',
          code: 'goal_not_found',
          message: '当前会话没有可操作的 Goal。',
        }
      if (tail === 'pause')
        await this.dependencies.pauseGoal(active.id, context.sessionId)
      else if (tail === 'resume')
        await this.dependencies.resumeGoal(active.id, context.sessionId)
      else
        await this.dependencies.cancelGoal(
          active.id,
          'slash_command',
          context.sessionId,
        )
      return completed(
        context,
        `goal_${tail}`,
        `Goal 已${tail === 'pause' ? '暂停' : tail === 'resume' ? '恢复' : '取消'}。`,
      )
    }
    const outcome = tail.replace(/^start\s+/i, '').trim()
    if (!outcome)
      return { status: 'opened', surface: 'goal', params: { action: 'start' } }
    await this.dependencies.startGoal(outcome, context.sessionId)
    return completed(context, 'goal_started', 'Goal 已启动。')
  }

  private schedulePrompt(
    context: CommandExecutionContext,
    content: string,
    displayContent = context.parsed.raw,
    skillName?: string,
  ): string {
    const promptId = `command_prompt_${randomUUID().replace(/-/g, '').slice(0, 20)}`
    void this.dependencies
      .submitPrompt({
        sessionId: context.sessionId,
        content,
        displayContent,
        clientMessageId: promptId,
        turnId: promptId,
        delivery: 'queue',
        source: 'command',
        requestedSkills: skillName
          ? [{ name: skillName, source: 'slash' }]
          : [],
        attachments: context.attachments,
      })
      .catch(() => undefined)
    return promptId
  }
}

function completed(
  context: CommandExecutionContext,
  code: string,
  message: string,
  data?: Record<string, unknown>,
): CommandInvocationResult {
  return {
    status: 'completed',
    receipt: {
      commandId: context.descriptor.id,
      code,
      message,
      ...(data ? { data } : {}),
    },
  }
}
