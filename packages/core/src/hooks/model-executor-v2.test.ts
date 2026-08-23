import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolCallRequest } from '../providers/base'
import { defaultHooksConfigV2 } from './schema'
import {
  AgentHookExecutor,
  PromptHookExecutor,
  type HookModelGateway,
  type HookModelRequest,
  type HookModelResponse,
} from './model-executor'

type Dict = Record<string, unknown>

class FakeGateway implements HookModelGateway {
  readonly calls: HookModelRequest[] = []
  readonly responses: Array<
    | HookModelResponse
    | ((request: HookModelRequest) => Promise<HookModelResponse>)
  >

  constructor(
    ...responses: Array<
      | HookModelResponse
      | ((request: HookModelRequest) => Promise<HookModelResponse>)
    >
  ) {
    this.responses = responses
  }

  async call(request: HookModelRequest): Promise<HookModelResponse> {
    this.calls.push(request)
    const response = this.responses.shift()
    if (!response) return modelResponse(null, [])
    return typeof response === 'function' ? response(request) : response
  }
}

function modelResponse(
  content: string | null,
  toolCalls: ToolCallRequest[] = [],
): HookModelResponse {
  return { content, toolCalls, usage: {} }
}

function promptHandler(overrides: Dict = {}): Dict {
  return {
    id: 'prompt-1',
    type: 'prompt',
    enabled: true,
    prompt: 'Check this event',
    modelRole: 'secondary',
    timeoutMs: 1_000,
    statusMessage: '',
    once: false,
    ...overrides,
  }
}

function agentHandler(overrides: Dict = {}): Dict {
  return {
    id: 'agent-1',
    type: 'agent',
    enabled: true,
    prompt: 'Investigate this event',
    modelRole: 'secondary',
    timeoutMs: 1_000,
    statusMessage: '',
    once: false,
    maxTurns: 3,
    ...overrides,
  }
}

function input(overrides: Dict = {}): Dict {
  return {
    hook_event_name: 'Stop',
    session_id: 's1',
    cwd: '/repo',
    state_root: '/state',
    stop_reason: 'complete',
    ...overrides,
  }
}

function context(cwd: string, eventName = 'Stop', overrides: Dict = {}): Dict {
  return { eventName, cwd, policy: defaultHooksConfigV2().policy, ...overrides }
}

describe('hooks v2 model executors', () => {
  it('runs prompt hooks as one secondary no-tool request and parses a strict ok result', async () => {
    const gateway = new FakeGateway(
      modelResponse(
        '{"ok":true,"output":{"decision":"allow","reason":"clean"}}',
      ),
    )
    const executor = new PromptHookExecutor(gateway)

    const result = await executor.execute(
      promptHandler() as never,
      input(),
      context('/repo') as never,
    )

    expect(result).toMatchObject({
      outcome: 'completed',
      output: { decision: 'allow', reason: 'clean' },
    })
    expect(gateway.calls).toHaveLength(1)
    expect(gateway.calls[0]).toMatchObject({
      useCase: 'hook_prompt',
      modelRole: 'secondary',
      tools: null,
    })
  })

  it('maps an explicit prompt rejection to deny and rejects malformed model output', async () => {
    const deniedGateway = new FakeGateway(
      modelResponse('{"ok":false,"reason":"unsafe"}'),
    )
    const malformedGateway = new FakeGateway(
      modelResponse('```json\n{"ok":true}\n```'),
    )

    const denied = await new PromptHookExecutor(deniedGateway).execute(
      promptHandler() as never,
      input(),
      context('/repo') as never,
    )
    const malformed = await new PromptHookExecutor(malformedGateway).execute(
      promptHandler() as never,
      input(),
      context('/repo') as never,
    )

    expect(denied).toMatchObject({
      outcome: 'completed',
      output: { decision: 'deny', reason: 'unsafe' },
    })
    expect(malformed).toMatchObject({ outcome: 'failed', output: null })
  })

  it('distinguishes prompt timeout from parent cancellation', async () => {
    const hanging = async (
      request: HookModelRequest,
    ): Promise<HookModelResponse> =>
      await new Promise((_resolve, reject) => {
        request.signal?.addEventListener(
          'abort',
          () => reject(request.signal?.reason),
          { once: true },
        )
      })
    const timedOut = await new PromptHookExecutor(
      new FakeGateway(hanging),
    ).execute(
      promptHandler({ timeoutMs: 20 }) as never,
      input(),
      context('/repo') as never,
    )
    const controller = new AbortController()
    const running = new PromptHookExecutor(new FakeGateway(hanging)).execute(
      promptHandler({ timeoutMs: 5_000 }) as never,
      input(),
      context('/repo', 'Stop', { signal: controller.signal }) as never,
    )
    controller.abort()

    expect(timedOut.outcome).toBe('timeout')
    expect((await running).outcome).toBe('cancelled')
  })

  it('exposes only read/glob/grep and structured result tools to hook agents', async () => {
    const gateway = new FakeGateway(
      modelResponse(null, [
        {
          id: 'submit-1',
          name: 'submit_hook_result',
          arguments: {
            ok: true,
            output: { continue: true, stopReason: 'inspect more' },
          },
        },
      ]),
    )
    const executor = new AgentHookExecutor(gateway)

    const result = await executor.execute(
      agentHandler() as never,
      input(),
      context('/repo') as never,
    )
    const toolNames = gateway.calls[0]?.tools
      ?.map((tool) => String(tool.name))
      .sort()

    expect(toolNames).toEqual([
      'glob',
      'grep',
      'read_file',
      'submit_hook_result',
    ])
    expect(result).toMatchObject({
      outcome: 'completed',
      output: { continue: true, stopReason: 'inspect more' },
    })
  })

  it('requires structured agent submission and fails at the bounded turn limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-agent-'))
    await writeFile(join(root, 'README.md'), 'hello\n', 'utf8')
    try {
      const readCall = modelResponse(null, [
        { id: 'read-1', name: 'read_file', arguments: { path: 'README.md' } },
      ])
      const gateway = new FakeGateway(readCall, readCall, readCall)
      const result = await new AgentHookExecutor(gateway).execute(
        agentHandler({ maxTurns: 2 }) as never,
        input({ cwd: root }),
        context(root) as never,
      )

      expect(result).toMatchObject({ outcome: 'failed', output: null })
      expect(result.reason).toMatch(/structured result|max turns/i)
      expect(gateway.calls).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('redacts and bounds model context and prevents recursive hook model calls', async () => {
    const gateway = new FakeGateway(modelResponse('{"ok":true,"output":{}}'))
    const policy = defaultHooksConfigV2().policy
    policy.maxContextBytes = 240
    const executor = new PromptHookExecutor(gateway)
    await executor.execute(
      promptHandler({ modelRole: 'main' }) as never,
      input({
        api_key: 'never-send-this',
        transcript_path: '/secret/transcript',
        large: 'x'.repeat(4_000),
      }),
      context('/repo', 'Stop', { policy }) as never,
    )
    const serialized = JSON.stringify(gateway.calls[0]?.messages ?? [])

    expect(gateway.calls[0]?.modelRole).toBe('main')
    expect(Buffer.byteLength(serialized)).toBeLessThan(1_200)
    expect(serialized).not.toContain('never-send-this')
    expect(serialized).not.toContain('/secret/transcript')

    const recursive = await executor.execute(
      promptHandler() as never,
      input({ hook_depth: 1 }),
      context('/repo') as never,
    )
    expect(recursive.reason).toMatch(/recursive|depth/i)
    expect(gateway.calls).toHaveLength(1)
  })

  it('rejects model handlers on events whose capability table does not allow them', async () => {
    const gateway = new FakeGateway(modelResponse('{"ok":true,"output":{}}'))
    const result = await new AgentHookExecutor(gateway).execute(
      agentHandler() as never,
      input({ hook_event_name: 'SessionStart' }),
      context('/repo', 'SessionStart') as never,
    )

    expect(result).toMatchObject({ outcome: 'failed', output: null })
    expect(result.reason).toMatch(/not allowed/i)
    expect(gateway.calls).toHaveLength(0)
  })
})
