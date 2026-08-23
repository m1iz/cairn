import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HookAggregateDecision } from '../hooks/models'
import { TaskManager } from '../tasks/manager'
import { TeamManager } from '../team/manager'
import { Tool } from '../tools/base'
import { DispatchSubagentTool } from '../tools/dispatch'
import { ToolRegistry } from '../tools/registry'
import { toolParamsSchema } from '../tools/schema'
import { SubagentRegistry } from './registry'

const TEMPLATES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'templates',
  'subagents',
)

class ReadTool extends Tool {
  readonly name = 'read_file'
  readonly description = 'read'
  readonly parameters = toolParamsSchema({})
  override readOnly = true
  execute(): string {
    return 'read'
  }
}

function pass(context = ''): HookAggregateDecision {
  return {
    decision: 'passthrough',
    reason: '',
    results: [],
    additionalContext: context,
  }
}

function root(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function dispatchArgs(): Record<string, unknown> {
  return {
    agent_type: 'code_explorer',
    task: 'inspect docs',
    purpose: 'read',
    expected_output: 'summary',
    evidence_required: 'paths',
    scope_limit: 'readonly',
  }
}

describe('subagent hook lifecycle', () => {
  it('uses unique scopes, injects SubagentStart context, and clears every scope', async () => {
    const parent = new ToolRegistry()
    parent.register(new ReadTool())
    const starts: string[] = []
    const ended: string[] = []
    const histories: Array<Array<Record<string, unknown>>> = []
    const factoryArgs: Array<Record<string, unknown>> = []
    const tool = new DispatchSubagentTool({
      parentRegistry: parent,
      subagentRegistry: new SubagentRegistry(TEMPLATES),
      taskManager: new TaskManager(root('subagent-hooks-tasks-')),
      hooks: {
        begin: async (opts) => {
          starts.push(opts.agentId)
          return pass(`scope:${opts.agentId}`)
        },
        end: (agentId) => {
          ended.push(agentId)
        },
      },
      runnerFactory: (args) => {
        factoryArgs.push(args as unknown as Record<string, unknown>)
        return {
          step: (history) => {
            histories.push(history.map((message) => ({ ...message })))
            return 'done'
          },
        }
      },
    })

    const [first, second] = await Promise.all([
      tool.execute(dispatchArgs(), {
        root: '/repo',
        workspaceRoot: '/repo',
        arguments: {},
        sessionId: 's1',
      }),
      tool.execute(dispatchArgs(), {
        root: '/repo',
        workspaceRoot: '/repo',
        arguments: {},
        sessionId: 's1',
      }),
    ])

    expect(first).toBe('done')
    expect(second).toBe('done')
    expect(new Set(starts).size).toBe(2)
    expect(ended.sort()).toEqual([...starts].sort())
    expect(
      histories.every((history) =>
        JSON.stringify(history[0]).includes('SubagentStart hook context'),
      ),
    ).toBe(true)
    expect(
      factoryArgs.every(
        (args) =>
          args.sessionId === 's1' && starts.includes(String(args.agentId)),
      ),
    ).toBe(true)
  })

  it('clears a subagent scope when the nested runner fails', async () => {
    const parent = new ToolRegistry()
    parent.register(new ReadTool())
    let started = ''
    const ended: string[] = []
    const tool = new DispatchSubagentTool({
      parentRegistry: parent,
      subagentRegistry: new SubagentRegistry(TEMPLATES),
      hooks: {
        begin: async (opts) => {
          started = opts.agentId
          return pass()
        },
        end: (agentId) => {
          ended.push(agentId)
        },
      },
      runnerFactory: () => ({
        step: () => {
          throw new Error('nested failed')
        },
      }),
    })

    expect(
      await tool.execute(dispatchArgs(), {
        root: '/repo',
        arguments: {},
        sessionId: 's1',
      }),
    ).toContain('nested failed')
    expect(ended).toEqual([started])
  })
})

describe('team hook lifecycle', () => {
  it('injects start context and clears team scopes on success and failure', async () => {
    const starts: string[] = []
    const ended: string[] = []
    const histories: Array<Array<Record<string, unknown>>> = []
    let fail = false
    const manager = new TeamManager({
      root: root('team-hooks-'),
      subagentRegistry: {
        get: () => ({ name: 'code_explorer', toolNames: [] }),
        resolveName: () => 'code_explorer',
        names: () => ['code_explorer'],
      },
      hooks: {
        begin: async (opts) => {
          starts.push(opts.agentId)
          return pass(`team:${opts.teammateName}`)
        },
        end: (agentId) => {
          ended.push(agentId)
        },
      },
      runnerFactory: () => ({
        step: (history) => {
          histories.push(history.map((message) => ({ ...message })))
          if (fail) throw new Error('team failed')
          return 'team done'
        },
      }),
    })

    await manager.spawnTeammate({
      name: 'alice',
      role: 'reader',
      task: 'first',
    })
    fail = true
    await manager.sendMessage({ to: 'alice', content: 'second', wake: true })

    expect(starts).toHaveLength(2)
    expect(ended.sort()).toEqual([...starts].sort())
    expect(
      histories.every((history) =>
        JSON.stringify(history).includes('SubagentStart hook context'),
      ),
    ).toBe(true)
  })
})
