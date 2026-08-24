import type {
  AssistantMessage,
  BootstrapPayload,
  PendingState,
  TeamMessage,
  WsEvent,
} from '../types'
import { finishTimedState } from './chatProjection'
import { applySchedulerEventToBootstrap } from './handlers/scheduler'
import { applyTeamEventToBootstrap } from './handlers/team'
import { findSubagent, findSubagentTool, findToolSegment } from './selectors'

const SCHEDULER_DONE_PENDING_MS = 2500

type UpdatePending = (
  label?: string,
  detail?: string,
  tone?: PendingState['tone'],
  autoClearMs?: number,
) => void

export interface AgentEventHandlerDeps {
  assistantForTurn(turnId?: string): AssistantMessage | undefined
  updatePending: UpdatePending
  boot(): BootstrapPayload | null
  countTeamUnread(): boolean
}

export function createAgentEventHandlers(deps: AgentEventHandlerDeps) {
  const timedFinish = (
    state: { startedAt?: number; endedAt?: number; durationMs?: number },
    endedAt = Date.now(),
  ) => finishTimedState(state, endedAt)

  const eventTimeMs = (data?: { ts?: number }) => {
    const raw = typeof data?.ts === 'number' ? data.ts : 0
    if (!raw) return Date.now()
    return raw < 1_000_000_000_000 ? Math.round(raw * 1000) : Math.round(raw)
  }

  function handleSubagentEvent(data: WsEvent) {
    const assistant = deps.assistantForTurn(data.turn_id)
    if (!assistant) return

    if (data.event === 'subagent_start') {
      const segment = findToolSegment(assistant, data.parent_id)
      if (segment) {
        segment.subagents ||= []
        segment.subagents.push({
          id: data.subagent_id,
          agent_type: data.agent_type,
          kind: 'subagent',
          purpose: data.purpose,
          status: 'running',
          content: '',
          tools: [],
          startedAt: eventTimeMs(data),
        })
      }
      deps.updatePending(
        `派遣子代理: ${data.agent_type || 'subagent'}`,
        data.purpose || '',
      )
      return
    }
    if (data.event === 'subagent_delta') {
      const subagent = findSubagent(assistant, data.parent_id, data.subagent_id)
      if (subagent)
        subagent.content = `${subagent.content || ''}${data.delta || ''}`
      deps.updatePending(
        `子代理 ${data.agent_type || 'subagent'} 处理中...`,
        '',
      )
      return
    }
    if (data.event === 'subagent_tool_call') {
      const subagent = findSubagent(assistant, data.parent_id, data.subagent_id)
      if (subagent) {
        subagent.tools ||= []
        subagent.tools.push({
          id: data.id,
          name: data.name,
          arguments: data.arguments || {},
          status: 'running',
          startedAt: eventTimeMs(data),
        })
      }
      deps.updatePending(`子代理调用: ${data.name}`, '')
      return
    }
    if (
      data.event === 'subagent_tool_result' ||
      data.event === 'subagent_tool_error'
    ) {
      const tool = findSubagentTool(
        assistant,
        data.parent_id,
        data.subagent_id,
        data.id,
      )
      if (tool) {
        timedFinish(tool, eventTimeMs(data))
        tool.summary =
          data.event === 'subagent_tool_result'
            ? data.summary || '已完成'
            : data.message || '工具执行出错'
        tool.status = data.event === 'subagent_tool_result' ? 'done' : 'error'
      }
      if (data.event === 'subagent_tool_error')
        deps.updatePending(
          `子代理工具 ${data.name || ''} 出错`,
          data.message || '',
          'error',
        )
      return
    }
    if (data.event === 'subagent_done' || data.event === 'subagent_error') {
      const subagent = findSubagent(assistant, data.parent_id, data.subagent_id)
      if (subagent) {
        timedFinish(subagent, eventTimeMs(data))
        subagent.status = data.event === 'subagent_done' ? 'done' : 'error'
        if (data.event === 'subagent_done') subagent.summary = data.summary
        else subagent.error = data.message
      }
      if (data.event === 'subagent_done')
        deps.updatePending('AI 正在整理结果...', '')
      else
        deps.updatePending(
          `子代理 ${data.agent_type || ''} 出错`,
          data.message || '',
          'error',
        )
    }
  }

  function handleTeamEvent(data: WsEvent) {
    const boot = deps.boot()
    if (boot)
      applyTeamEventToBootstrap(boot, data, {
        countUnread: deps.countTeamUnread(),
      })
    const assistant = deps.assistantForTurn(data.turn_id)

    if (data.event === 'team_member_update') {
      deps.updatePending(
        data.member?.status === 'working'
          ? `队友 ${data.member.name} 正在办差`
          : '',
        '',
      )
      return
    }
    if (data.event === 'team_message') {
      if (assistant && data.message) attachTeamMessage(assistant, data.message)
      if (data.message?.to === 'lead')
        deps.updatePending('队友有新回复', data.message.from, 'done')
      return
    }
    if (!assistant) return

    if (data.event === 'team_run_start') {
      const segment = findToolSegment(assistant, data.parent_id)
      if (segment) {
        segment.subagents ||= []
        segment.subagents.push({
          id: data.teammate,
          kind: 'team',
          agent_type: data.agent_type,
          role: data.role,
          purpose: data.purpose,
          status: 'running',
          content: '',
          tools: [],
          messages: [],
          startedAt: eventTimeMs(data),
        })
      }
      deps.updatePending(
        `队友 ${data.teammate || ''} 已唤醒`,
        data.purpose || '',
      )
      return
    }
    if (data.event === 'team_run_delta') {
      const teammate = findSubagent(assistant, data.parent_id, data.teammate)
      if (teammate)
        teammate.content = `${teammate.content || ''}${data.delta || ''}`
      deps.updatePending(`队友 ${data.teammate || ''} 处理中...`, '')
      return
    }
    if (data.event === 'team_run_tool_call') {
      const teammate = findSubagent(assistant, data.parent_id, data.teammate)
      if (teammate) {
        teammate.tools ||= []
        teammate.tools.push({
          id: data.id,
          name: data.name,
          arguments: data.arguments || {},
          status: 'running',
          startedAt: eventTimeMs(data),
        })
      }
      deps.updatePending(`队友调用: ${data.name}`, data.teammate || '')
      return
    }
    if (
      data.event === 'team_run_tool_result' ||
      data.event === 'team_run_tool_error'
    ) {
      const tool = findSubagentTool(
        assistant,
        data.parent_id,
        data.teammate,
        data.id,
      )
      if (tool) {
        timedFinish(tool, eventTimeMs(data))
        tool.summary =
          data.event === 'team_run_tool_result'
            ? data.summary || '已完成'
            : data.message || '工具执行出错'
        tool.status = data.event === 'team_run_tool_result' ? 'done' : 'error'
      }
      if (data.event === 'team_run_tool_error')
        deps.updatePending(
          `队友工具 ${data.name || ''} 出错`,
          data.message || '',
          'error',
        )
      return
    }
    if (data.event === 'team_run_done' || data.event === 'team_run_error') {
      const teammate = findSubagent(assistant, data.parent_id, data.teammate)
      if (teammate) {
        timedFinish(teammate, eventTimeMs(data))
        teammate.status = data.event === 'team_run_done' ? 'done' : 'error'
        if (data.event === 'team_run_done') teammate.summary = data.summary
        else teammate.error = data.message
      }
      if (data.event === 'team_run_done')
        deps.updatePending('AI 正在整理队友回复...', '')
      else
        deps.updatePending(
          `队友 ${data.teammate || ''} 出错`,
          data.message || '',
          'error',
        )
    }
  }

  function handleSchedulerEvent(data: WsEvent) {
    const boot = deps.boot()
    if (boot) applySchedulerEventToBootstrap(boot, data)
    const schedulerStates: Record<
      string,
      { label: string; tone: PendingState['tone']; timeout: number }
    > = {
      scheduler_run_done: {
        label: 'Scheduler 任务已完成',
        tone: 'done',
        timeout: SCHEDULER_DONE_PENDING_MS,
      },
      scheduler_run_error: {
        label: 'Scheduler 任务失败',
        tone: 'error',
        timeout: 0,
      },
      scheduler_run_cancelled: {
        label: 'Scheduler 任务已停止',
        tone: 'done',
        timeout: SCHEDULER_DONE_PENDING_MS,
      },
      scheduler_run_skipped: {
        label: 'Scheduler 任务已跳过',
        tone: 'done',
        timeout: SCHEDULER_DONE_PENDING_MS,
      },
      scheduler_run_interrupted: {
        label: 'Scheduler 任务已中断',
        tone: 'done',
        timeout: SCHEDULER_DONE_PENDING_MS,
      },
      scheduler_job_update: {
        label: 'Scheduler 任务已更新',
        tone: 'done',
        timeout: SCHEDULER_DONE_PENDING_MS,
      },
    }
    if (data.event === 'scheduler_run_start') {
      deps.updatePending(
        'Scheduler 正在执行任务',
        data.job?.name || data.job?.id || '',
      )
      return
    }
    const state = schedulerStates[data.event]
    if (!state) return
    const schedulerEvent = data as WsEvent & {
      job?: { id?: string; name?: string; state?: { lastError?: string } }
      error?: string
      reason?: string
      action?: string
    }
    const detail =
      data.event === 'scheduler_run_error'
        ? schedulerEvent.error || schedulerEvent.job?.state?.lastError || ''
        : data.event === 'scheduler_job_update'
          ? schedulerEvent.action || ''
          : schedulerEvent.job?.name ||
            schedulerEvent.job?.id ||
            schedulerEvent.reason ||
            ''
    deps.updatePending(state.label, detail, state.tone, state.timeout)
  }

  return { handleSubagentEvent, handleTeamEvent, handleSchedulerEvent }
}

function attachTeamMessage(assistant: AssistantMessage, message: TeamMessage) {
  const teammate = message.to === 'lead' ? message.from : message.to
  if (!teammate || teammate === 'lead') return
  const subagent = findTeamSubagent(assistant, teammate)
  if (!subagent) return
  subagent.messages ||= []
  if (!subagent.messages.some((item) => item.id === message.id)) {
    subagent.messages.push(message)
    subagent.messages = subagent.messages.slice(-8)
  }
}

function findTeamSubagent(assistant: AssistantMessage, teammate: string) {
  for (const segment of assistant.segments) {
    if (segment.type !== 'tool') continue
    const subagent = segment.subagents?.find(
      (item) => item.kind === 'team' && item.id === teammate,
    )
    if (subagent) return subagent
  }
  return undefined
}
