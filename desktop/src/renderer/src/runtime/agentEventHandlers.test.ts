import { describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, WsEvent } from '../types'
import { createAgentEventHandlers } from './agentEventHandlers'

function assistant(): AssistantMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    streaming: true,
    segments: [
      {
        id: 'tool-parent',
        toolId: 'tool-parent',
        type: 'tool',
        name: 'dispatch_subagent',
        status: 'running',
        arguments: {},
      },
    ],
  }
}

describe('createAgentEventHandlers', () => {
  it('projects subagent lifecycle into the owning tool segment', () => {
    const message = assistant()
    const updatePending = vi.fn()
    const handlers = createAgentEventHandlers({
      assistantForTurn: () => message,
      updatePending,
      boot: () => null,
      countTeamUnread: () => true,
    })

    handlers.handleSubagentEvent({
      event: 'subagent_start',
      turn_id: 'turn-1',
      parent_id: 'tool-parent',
      subagent_id: 'subagent-1',
      agent_type: 'reviewer',
      purpose: 'review changes',
      ts: 10,
    } as WsEvent)
    handlers.handleSubagentEvent({
      event: 'subagent_done',
      turn_id: 'turn-1',
      parent_id: 'tool-parent',
      subagent_id: 'subagent-1',
      summary: 'looks good',
      ts: 11,
    } as WsEvent)

    const segment = message.segments[0]
    expect(
      segment.type === 'tool' ? segment.subagents?.[0] : null,
    ).toMatchObject({
      id: 'subagent-1',
      status: 'done',
      summary: 'looks good',
      startedAt: 10_000,
      endedAt: 11_000,
    })
    expect(updatePending).toHaveBeenLastCalledWith('AI 正在整理结果...', '')
  })

  it('maps scheduler terminal states to one bounded pending update', () => {
    const updatePending = vi.fn()
    const handlers = createAgentEventHandlers({
      assistantForTurn: () => undefined,
      updatePending,
      boot: () => null,
      countTeamUnread: () => false,
    })

    handlers.handleSchedulerEvent({
      event: 'scheduler_run_done',
      job: { id: 'job-1', name: 'Daily review' },
    } as WsEvent)

    expect(updatePending).toHaveBeenCalledWith(
      'Scheduler 任务已完成',
      'Daily review',
      'done',
      2500,
    )
  })
})
