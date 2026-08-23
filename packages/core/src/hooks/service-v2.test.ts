import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HookCommandHandlerV2 } from './models'
import {
  HookExecutorRegistry,
  type HookExecutorContext,
  type HookExecutorResultV2,
  type HookHandlerExecutor,
} from './executor'
import { HookService } from './service'
import { ExecutionEnvironment } from '../environment/snapshot'

class FakeCommandExecutor implements HookHandlerExecutor<HookCommandHandlerV2> {
  readonly type = 'command' as const
  readonly contexts: HookExecutorContext[] = []
  async execute(
    handler: HookCommandHandlerV2,
    _input: Record<string, unknown>,
    context: HookExecutorContext,
  ): Promise<HookExecutorResultV2> {
    this.contexts.push(context)
    const [decision, reason] = handler.args
    return {
      outcome: 'completed',
      output: { decision, reason },
      reason: reason ?? '',
      durationMs: 1,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    }
  }
}

function executionEnvironment(revisionCharacter: string): ExecutionEnvironment {
  return new ExecutionEnvironment(
    {
      revision: revisionCharacter.repeat(64),
      catalogRevision: 'a'.repeat(64),
      projectFingerprint: 'b'.repeat(64),
      createdAt: '2026-07-11T02:00:00.000Z',
      platform: 'darwin',
      pathEntries: [`/${revisionCharacter}/bin`],
      env: { PATH: `/${revisionCharacter}/bin` },
      toolPaths: {},
    },
    {},
  )
}

function config(decision: 'deny' | 'allow', reason: string): Dict {
  return {
    version: 2,
    hooks: {
      PreToolUse: [
        {
          id: 'guard',
          enabled: true,
          matcher: 'write_file',
          if: '',
          failureMode: 'closed',
          handlers: [
            {
              id: 'command-1',
              type: 'command',
              enabled: true,
              command: 'fake',
              args: [decision, reason],
              shell: 'none',
              allowedEnv: [],
              async: false,
              asyncRewake: false,
              timeoutMs: 1_000,
              statusMessage: '',
              once: false,
            },
          ],
        },
      ],
    },
  }
}

type Dict = Record<string, unknown>

describe('HookService turn snapshots', () => {
  it('pins one execution environment for a turn and agent scopes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-service-environment-'))
    try {
      await writeFile(
        join(root, 'hooks_config.json'),
        JSON.stringify(config('allow', 'environment')),
        'utf8',
      )
      const executor = new FakeCommandExecutor()
      const executors = new HookExecutorRegistry()
      executors.register(executor)
      let current = executionEnvironment('c')
      const service = new HookService({
        stateRoot: root,
        executors,
        executionEnvironment: async () => current,
      })
      await service.beginTurn({
        turnId: 'turn-environment',
        sessionId: 's1',
        projectRoot: null,
      })
      current = executionEnvironment('d')
      await service.beginAgentScope({
        agentId: 'agent-1',
        agentType: 'reader',
        sessionId: 's1',
        cwd: '/repo',
      })
      await service.run('PreToolUse', {
        sessionId: 's1',
        turnId: 'turn-environment',
        cwd: '/repo',
        toolName: 'write_file',
        toolInput: { path: 'README.md' },
      })
      await service.runAgent('PreToolUse', 'agent-1', {
        toolName: 'write_file',
        toolInput: { path: 'README.md' },
      })

      expect(
        executor.contexts.map((entry) => entry.executionEnvironment?.revision),
      ).toEqual(['c'.repeat(64), 'c'.repeat(64)])
      expect(
        service.agentScope('agent-1')?.executionEnvironment?.revision,
      ).toBe('c'.repeat(64))
      service.endTurn('turn-environment')
      await service.beginTurn({
        turnId: 'turn-next',
        sessionId: 's1',
        projectRoot: null,
      })
      await service.run('PreToolUse', {
        sessionId: 's1',
        turnId: 'turn-next',
        cwd: '/repo',
        toolName: 'write_file',
        toolInput: { path: 'README.md' },
      })
      expect(executor.contexts.at(-1)?.executionEnvironment?.revision).toBe(
        'd'.repeat(64),
      )
      await service.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps one immutable revision for a turn and adopts changes next turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-service-'))
    try {
      const configPath = join(root, 'hooks_config.json')
      await writeFile(
        configPath,
        JSON.stringify(config('deny', 'revision-a')),
        'utf8',
      )
      const executors = new HookExecutorRegistry()
      executors.register(new FakeCommandExecutor())
      const service = new HookService({ stateRoot: root, executors })
      const first = await service.beginTurn({
        turnId: 'turn-1',
        sessionId: 's1',
        projectRoot: null,
      })
      await writeFile(
        configPath,
        JSON.stringify(config('allow', 'revision-b')),
        'utf8',
      )

      const duringTurn = await service.run('PreToolUse', {
        sessionId: 's1',
        turnId: 'turn-1',
        cwd: '/repo',
        toolName: 'write_file',
        toolInput: { path: 'README.md' },
        toolUseId: 'call-1',
      })
      const same = service.activeSnapshot('s1')
      service.endTurn('turn-1')
      const second = await service.beginTurn({
        turnId: 'turn-2',
        sessionId: 's1',
        projectRoot: null,
      })
      const nextTurn = await service.run('PreToolUse', {
        sessionId: 's1',
        turnId: 'turn-2',
        cwd: '/repo',
        toolName: 'write_file',
        toolInput: { path: 'README.md' },
        toolUseId: 'call-2',
      })

      expect(duringTurn).toMatchObject({
        decision: 'deny',
        reason: 'revision-a',
      })
      expect(same?.revision).toBe(first.revision)
      expect(second.revision).not.toBe(first.revision)
      expect(nextTurn).toMatchObject({
        decision: 'allow',
        reason: 'revision-b',
      })
      await service.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('provides a synchronous no-match proof only from an active snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-service-match-'))
    try {
      await writeFile(
        join(root, 'hooks_config.json'),
        JSON.stringify(config('deny', 'blocked')),
        'utf8',
      )
      const executors = new HookExecutorRegistry()
      executors.register(new FakeCommandExecutor())
      const service = new HookService({ stateRoot: root, executors })

      expect(
        service.mayMatch('PreToolUse', {
          sessionId: 's1',
          cwd: '/repo',
          toolName: 'read_file',
        }),
      ).toBe(true)
      await service.beginTurn({
        turnId: 'turn-1',
        sessionId: 's1',
        projectRoot: null,
      })
      expect(
        service.mayMatch('PreToolUse', {
          sessionId: 's1',
          cwd: '/repo',
          toolName: 'read_file',
        }),
      ).toBe(false)
      expect(
        service.mayMatch('PreToolUse', {
          sessionId: 's1',
          cwd: '/repo',
          toolName: 'write_file',
        }),
      ).toBe(true)
      await service.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('executes a 100-handler match plan from one turn snapshot without resolving sources again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-service-large-plan-'))
    try {
      await writeFile(
        join(root, 'hooks_config.json'),
        JSON.stringify({
          version: 2,
          policy: { maxConcurrency: 4 },
          hooks: {
            PreToolUse: Array.from({ length: 100 }, (_, index) => ({
              id: `group-${index}`,
              enabled: true,
              matcher: 'write_file',
              if: '',
              failureMode: 'open',
              handlers: [
                handlerConfig(`handler-${index}`, 'allow', `handler-${index}`),
              ],
            })),
          },
        }),
        'utf8',
      )
      const executors = new HookExecutorRegistry()
      executors.register(new FakeCommandExecutor())
      const service = new HookService({ stateRoot: root, executors })
      const resolveSources = service.resolver.resolve.bind(service.resolver)
      let resolveCount = 0
      service.resolver.resolve = async (opts = {}) => {
        resolveCount += 1
        return await resolveSources(opts)
      }

      await service.beginTurn({
        turnId: 'turn-large',
        sessionId: 's1',
        projectRoot: null,
      })
      const result = await service.run('PreToolUse', {
        sessionId: 's1',
        turnId: 'turn-large',
        cwd: '/repo',
        toolName: 'write_file',
        toolInput: { path: 'README.md' },
        toolUseId: 'call-large',
      })

      expect(result.results).toHaveLength(100)
      expect(result.results.map((entry) => entry.handlerId)).toEqual(
        Array.from({ length: 100 }, (_, index) => `handler-${index}`),
      )
      expect(resolveCount).toBe(1)
      await service.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('isolates parallel agent scopes and inherits the parent turn snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-service-agent-scope-'))
    try {
      const configPath = join(root, 'hooks_config.json')
      await writeFile(
        configPath,
        JSON.stringify(config('deny', 'parent-revision')),
        'utf8',
      )
      const executors = new HookExecutorRegistry()
      executors.register(new FakeCommandExecutor())
      const service = new HookService({ stateRoot: root, executors })
      const parent = await service.beginTurn({
        turnId: 'turn-1',
        sessionId: 's1',
        projectRoot: null,
      })
      const [a, b] = await Promise.all([
        service.beginAgentScope({
          agentId: 'agent-a',
          agentType: 'reader',
          sessionId: 's1',
          cwd: '/repo',
        }),
        service.beginAgentScope({
          agentId: 'agent-b',
          agentType: 'reviewer',
          sessionId: 's1',
          cwd: '/repo',
        }),
      ])
      await writeFile(
        configPath,
        JSON.stringify(config('allow', 'new-disk-revision')),
        'utf8',
      )

      const nested = await service.runAgent('PreToolUse', 'agent-a', {
        toolName: 'write_file',
        toolInput: { path: 'x' },
        toolUseId: 'call-a',
      })

      expect(a.snapshot.revision).toBe(parent.revision)
      expect(b.snapshot.revision).toBe(parent.revision)
      expect(nested).toMatchObject({
        decision: 'deny',
        reason: 'parent-revision',
      })
      service.endAgentScope('agent-a')
      expect(service.agentScope('agent-a')).toBeNull()
      expect(service.agentScope('agent-b')?.agentType).toBe('reviewer')
      service.clearSession('s1')
      expect(service.agentScope('agent-b')).toBeNull()
      await service.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reviews API config writes with the old snapshot and does not write on deny', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-service-config-deny-'))
    try {
      const configPath = join(root, 'hooks_config.json')
      const original = {
        version: 2,
        hooks: {
          ConfigChange: [
            group(
              'config-guard',
              handlerConfig('config-deny', 'deny', 'keep old config'),
            ),
          ],
        },
      }
      await writeFile(configPath, JSON.stringify(original), 'utf8')
      const executors = new HookExecutorRegistry()
      executors.register(new FakeCommandExecutor())
      const service = new HookService({ stateRoot: root, executors })
      const previous = await service.snapshot({ sessionId: 's1' })

      const result = await service.saveGlobalConfig(
        { version: 2, hooks: {} },
        {
          expectedRevision: previous.revision,
          sessionId: 's1',
          cwd: '/repo',
        },
      )

      expect(result).toMatchObject({
        saved: false,
        decision: { decision: 'deny', reason: 'keep old config' },
      })
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(original)
      expect(result.snapshot.revision).toBe(previous.revision)
      await service.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the old active snapshot when an external trusted project change is denied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-service-project-deny-'))
    const project = await mkdtemp(join(tmpdir(), 'hook-service-project-'))
    try {
      await mkdir(join(project, '.cairn'), { recursive: true })
      await writeFile(
        join(root, 'hooks_config.json'),
        JSON.stringify({
          version: 2,
          projectHooks: { enabled: true },
          hooks: {
            ConfigChange: [
              group(
                'config-guard',
                handlerConfig('config-deny', 'deny', 'reject external'),
              ),
            ],
          },
        }),
        'utf8',
      )
      const projectPath = join(project, '.cairn', 'settings.json')
      await writeFile(
        projectPath,
        JSON.stringify(config('deny', 'project-a')),
        'utf8',
      )
      const executors = new HookExecutorRegistry()
      executors.register(new FakeCommandExecutor())
      const service = new HookService({ stateRoot: root, executors })
      const trust = await service.resolver.trustStore.status(project)
      await service.resolver.trustStore.set({
        projectRoot: project,
        expectedDigest: trust.digest,
        trusted: true,
      })
      const first = await service.snapshot({
        sessionId: 's1',
        projectRoot: project,
      })
      await writeFile(
        projectPath,
        JSON.stringify(config('allow', 'project-b')),
        'utf8',
      )

      const reviewed = await service.snapshot({
        sessionId: 's1',
        projectRoot: project,
      })

      expect(reviewed.revision).toBe(first.revision)
      expect(
        reviewed.diagnostics.some((item) => item.code === 'candidate_rejected'),
      ).toBe(true)
      expect(await readFile(projectPath, 'utf8')).toContain('project-b')
      await service.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(project, { recursive: true, force: true })
    }
  })
})

function handlerConfig(
  id: string,
  decision: 'deny' | 'allow',
  reason: string,
): Dict {
  return {
    id,
    type: 'command',
    enabled: true,
    command: 'fake',
    args: [decision, reason],
    shell: 'none',
    allowedEnv: [],
    async: false,
    asyncRewake: false,
    timeoutMs: 1_000,
    statusMessage: '',
    once: false,
  }
}

function group(id: string, command: Dict): Dict {
  return {
    id,
    enabled: true,
    matcher: '*',
    if: '',
    failureMode: 'closed',
    handlers: [command],
  }
}
