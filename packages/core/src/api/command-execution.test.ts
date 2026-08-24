import { describe, expect, it, vi } from 'vitest'
import type { CommandExecutionContext } from '../commands/platform'
import type { CommandDescriptor } from '../commands/types'
import {
  CoreCommandExecutionService,
  type CoreCommandExecutionDependencies,
} from './command-execution'

function dependencies(
  overrides: Partial<CoreCommandExecutionDependencies> = {},
): CoreCommandExecutionDependencies {
  return {
    reload: vi.fn(async () => undefined),
    clearSession: vi.fn(async () => ({ session: { id: 'next' } })),
    compactSession: vi.fn(async () => ({})),
    listActiveTasks: vi.fn(() => []),
    pauseGoal: vi.fn(async () => undefined),
    cancelTask: vi.fn(),
    cancelSessionRuntime: vi.fn(() => false),
    renameSession: vi.fn(async (_sessionId, title) => ({ title })),
    getModelConfig: vi.fn(async () => ({ models: [], current: null })),
    activateModel: vi.fn(async () => undefined),
    setReasoningEffort: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(),
    getControl: vi.fn(() => ({ mode: 'smart_auto' })),
    setControlMode: vi.fn(async () => undefined),
    listGoals: vi.fn(async () => []),
    resumeGoal: vi.fn(async () => undefined),
    cancelGoal: vi.fn(async () => undefined),
    startGoal: vi.fn(async () => undefined),
    getSubagent: vi.fn(() => null),
    subagentNames: vi.fn(() => []),
    submitPrompt: vi.fn(async () => undefined),
    ...overrides,
  }
}

function context(
  name: string,
  args: string[] = [],
  descriptor: Partial<CommandDescriptor> = {},
): CommandExecutionContext {
  return {
    sessionId: 'session-1',
    invocationId: 'invocation-1',
    invocationSource: 'desktop',
    descriptor: {
      id: `builtin:${name}`,
      name,
      aliases: [],
      category: 'test',
      description: name,
      kind: 'core_action',
      source: 'builtin',
      busyPolicy: 'immediate',
      argumentSchema: [],
      userInvocable: true,
      invocationSources: ['desktop'],
      available: true,
      ...descriptor,
    },
    parsed: {
      raw: `/${name}${args.length ? ` ${args.join(' ')}` : ''}`,
      name,
      args,
      options: {},
      tokens: [name, ...args],
    },
    arguments: { positional: {}, options: {} },
    attachments: [],
  }
}

describe('CoreCommandExecutionService', () => {
  it('executes reload and returns a stable command receipt', async () => {
    const deps = dependencies()
    const result = await new CoreCommandExecutionService(deps).executeBuiltin(
      context('reload'),
    )

    expect(deps.reload).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      status: 'completed',
      receipt: { commandId: 'builtin:reload', code: 'reloaded' },
    })
  })

  it('normalizes permission aliases before updating Control', async () => {
    const deps = dependencies()
    const result = await new CoreCommandExecutionService(deps).executeBuiltin(
      context('permissions', ['edits']),
    )

    expect(deps.setPermissionMode).toHaveBeenCalledWith('smart_auto')
    expect(result).toMatchObject({
      status: 'completed',
      receipt: { code: 'permission_mode_updated' },
    })
  })

  it('restores the saved execution mode when Plan is disabled', async () => {
    const deps = dependencies({
      getControl: () => ({ mode: 'plan', previous_mode: 'full_access' }),
    })
    await new CoreCommandExecutionService(deps).executeBuiltin(
      context('plan', ['off']),
    )

    expect(deps.setControlMode).toHaveBeenCalledWith('full_access')
  })

  it('routes an active Goal pause through the scoped Goal service', async () => {
    const deps = dependencies({
      listGoals: async () => [{ id: 'goal-1', status: 'active' }],
    })
    const result = await new CoreCommandExecutionService(deps).executeBuiltin(
      context('goal', ['pause']),
    )

    expect(deps.pauseGoal).toHaveBeenCalledWith('goal-1', 'session-1')
    expect(result).toMatchObject({
      status: 'completed',
      receipt: { code: 'goal_pause' },
    })
  })

  it('rejects a fork Skill whose tools exceed the subagent scope', async () => {
    const deps = dependencies({
      getSubagent: () => ({ toolNames: ['read_file'] }),
    })
    const result = await new CoreCommandExecutionService(deps).submitSkill(
      context('inspect', ['target'], {
        kind: 'agent_prompt',
        skill: {
          name: 'inspect',
          context: 'fork',
          agent: 'quick_check',
          allowedTools: ['write_file'],
          effort: null,
        },
      }),
    )

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'skill_fork_tool_scope_invalid',
    })
    expect(deps.submitPrompt).not.toHaveBeenCalled()
  })

  it('submits an inline Skill through the command-owned prompt queue', async () => {
    const deps = dependencies()
    const result = await new CoreCommandExecutionService(deps).submitSkill(
      context('inspect', ['target'], {
        kind: 'agent_prompt',
        skill: {
          name: 'inspect',
          context: 'inline',
          agent: null,
          allowedTools: [],
          effort: null,
        },
      }),
    )

    expect(result.status).toBe('submitted')
    expect(deps.submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        content: 'target',
        requestedSkills: [{ name: 'inspect', source: 'slash' }],
      }),
    )
  })
})
