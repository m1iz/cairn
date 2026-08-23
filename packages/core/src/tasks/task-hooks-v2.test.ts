import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HookAggregateDecision, HookEventName } from '../hooks'
import { TaskManager, type TaskHookHost } from './manager'
import { TaskKind, TaskStatus } from './models'

function decision(
  value: 'deny' | 'allow' | 'passthrough',
  reason = '',
): HookAggregateDecision {
  return { decision: value, reason, results: [], additionalContext: '' }
}

function host(run: TaskHookHost['run']): TaskHookHost {
  return { run }
}

function root(): string {
  return mkdtempSync(join(tmpdir(), 'task-hooks-v2-'))
}

describe('TaskManager hook transitions', () => {
  it('does not persist a TaskCreated candidate when hooks deny it', async () => {
    const events: HookEventName[] = []
    const manager = new TaskManager(root(), {
      hooks: host(async (event) => {
        events.push(event)
        return event === 'TaskCreated'
          ? decision('deny', 'no task')
          : decision('passthrough')
      }),
    })

    const created = await manager.startTaskWithHooks({
      kind: TaskKind.SUBAGENT,
      title: 'candidate',
      source: 'test',
      sessionId: 's1',
    })

    expect(created).toBeNull()
    expect(manager.store.list()).toEqual([])
    expect(events).toEqual(['TaskCreated'])
  })

  it('persists an allowed candidate and rejects completion without mutating running state', async () => {
    const manager = new TaskManager(root(), {
      hooks: host(async (event) =>
        event === 'TaskCompleted'
          ? decision('deny', 'not complete')
          : decision('allow'),
      ),
    })
    const created = await manager.startTaskWithHooks({
      kind: TaskKind.SUBAGENT,
      title: 'allowed',
      source: 'test',
      sessionId: 's1',
    })
    expect(created?.status).toBe(TaskStatus.RUNNING)

    const denied = await manager.completeTaskWithHooks(created!.id, {
      summary: 'done',
    })

    expect(denied).toMatchObject({ committed: false, reason: 'not complete' })
    expect(manager.store.get(created!.id)?.status).toBe(TaskStatus.RUNNING)
  })

  it('commits TaskCompleted only after hook approval', async () => {
    const manager = new TaskManager(root(), {
      hooks: host(async () => decision('allow')),
    })
    const created = await manager.startTaskWithHooks({
      kind: TaskKind.SUBAGENT,
      title: 'allowed',
      source: 'test',
      sessionId: 's1',
    })

    const completed = await manager.completeTaskWithHooks(created!.id, {
      summary: 'done',
    })

    expect(completed).toMatchObject({
      committed: true,
      record: { status: TaskStatus.COMPLETED },
    })
    expect(manager.store.get(created!.id)?.status).toBe(TaskStatus.COMPLETED)
  })
})
