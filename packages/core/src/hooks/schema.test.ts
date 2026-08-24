import { describe, expect, it } from 'vitest'
import { HOOK_EVENT_NAMES } from './models'

type Dict = Record<string, unknown>
type ParseResult = {
  config: Dict
  diagnostics: Array<{ code: string; path: string; message: string }>
}
type ParseV2 = (raw: unknown, opts?: { sourceKind?: string }) => ParseResult
type SerializeV2 = (config: Dict) => Dict
type ParseOutput = (
  eventName: string,
  raw: unknown,
) => { output: Dict | null; diagnostics: Array<{ code: string }> }

async function v2Api(): Promise<{
  parse: ParseV2
  serialize: SerializeV2
  parseOutput: ParseOutput
  defaultConfig: () => Dict
}> {
  const module = (await import('./schema')) as unknown as Record<
    string,
    unknown
  >
  expect(module.parseHooksConfig).toBeTypeOf('function')
  expect(module.serializeHooksConfig).toBeTypeOf('function')
  expect(module.parseHookOutput).toBeTypeOf('function')
  expect(module.defaultHooksConfig).toBeTypeOf('function')
  return {
    parse: module.parseHooksConfig as ParseV2,
    serialize: module.serializeHooksConfig as SerializeV2,
    parseOutput: module.parseHookOutput as ParseOutput,
    defaultConfig: module.defaultHooksConfig as () => Dict,
  }
}

describe('hooks foundation contracts', () => {
  it('exports only the 18 Cairn events that have real hosts', () => {
    expect(HOOK_EVENT_NAMES).toEqual([
      'SessionStart',
      'SessionEnd',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'PermissionDenied',
      'Stop',
      'StopFailure',
      'SubagentStart',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
      'ConfigChange',
      'TaskCreated',
      'TaskCompleted',
      'TeammateIdle',
    ])
  })

  it('defines event capabilities in the same registry as the event union', async () => {
    const module = (await import('./models')) as unknown as Record<
      string,
      unknown
    >
    const specs = module.HOOK_EVENT_SPECS as
      | Record<
          string,
          {
            matcherField: string | null
            mode: string
            allowedHandlers: string[]
          }
        >
      | undefined

    expect(specs).toBeDefined()
    expect(Object.keys(specs ?? {})).toEqual(HOOK_EVENT_NAMES)
    expect(specs?.PermissionRequest).toMatchObject({
      matcherField: 'tool_name',
      mode: 'transform',
    })
    expect(specs?.Stop).toMatchObject({
      mode: 'continue',
      allowedHandlers: ['command', 'http', 'prompt', 'agent'],
    })
    expect(specs?.SessionEnd).toMatchObject({
      matcherField: 'reason',
      mode: 'observe',
      allowedHandlers: ['command'],
    })
  })

  it('parses matcher groups containing all four persistent handler types', async () => {
    const { parse } = await v2Api()
    const parsed = parse({
      version: 2,
      enabled: true,
      projectHooks: { enabled: true },
      hooks: {
        Stop: [
          {
            id: 'finish-gates',
            matcher: '*',
            if: '',
            handlers: [
              {
                id: 'command-check',
                type: 'command',
                command: 'node',
                args: ['check.mjs'],
              },
              {
                id: 'http-check',
                type: 'http',
                url: 'https://hooks.example.test/stop',
              },
              {
                id: 'prompt-check',
                type: 'prompt',
                prompt: 'Check completion.',
              },
              {
                id: 'agent-check',
                type: 'agent',
                prompt: 'Inspect the result.',
              },
            ],
          },
        ],
      },
    })

    expect(parsed.diagnostics).toEqual([])
    expect(parsed.config).toMatchObject({
      version: 2,
      enabled: true,
      projectHooks: { enabled: true },
      hooks: {
        Stop: [
          {
            id: 'finish-gates',
            enabled: true,
            matcher: '*',
            if: '',
            failureMode: 'open',
            handlers: [
              {
                id: 'command-check',
                type: 'command',
                shell: 'none',
                timeoutMs: 10_000,
                async: false,
                asyncRewake: false,
              },
              { id: 'http-check', type: 'http', timeoutMs: 10_000 },
              {
                id: 'prompt-check',
                type: 'prompt',
                modelRole: 'secondary',
                timeoutMs: 30_000,
              },
              {
                id: 'agent-check',
                type: 'agent',
                modelRole: 'secondary',
                timeoutMs: 60_000,
                maxTurns: 12,
              },
            ],
          },
        ],
      },
    })
  })

  it('migrates legacy flat entries into deterministic one-handler groups', async () => {
    const { parse } = await v2Api()
    const first = parse({
      version: 1,
      hooks: {
        PreToolUse: [
          {
            id: 'protect-write',
            matcher: 'write_file',
            handler: { type: 'command', command: 'node', args: ['guard.mjs'] },
          },
          {
            matcher: 'edit_file',
            handler: { type: 'http', url: 'https://hooks.example.test/edit' },
          },
        ],
      },
    })
    const second = parse({
      version: 1,
      hooks: {
        PreToolUse: [
          {
            id: 'protect-write',
            matcher: 'write_file',
            handler: { type: 'command', command: 'node', args: ['guard.mjs'] },
          },
          {
            matcher: 'edit_file',
            handler: { type: 'http', url: 'https://hooks.example.test/edit' },
          },
        ],
      },
    })

    expect(first.diagnostics).toEqual([])
    expect(first.config).toEqual(second.config)
    expect(first.config).toMatchObject({
      version: 2,
      hooks: {
        PreToolUse: [
          {
            id: 'protect-write',
            handlers: [{ id: 'protect-write-handler-1', type: 'command' }],
          },
          {
            id: 'PreToolUse-2',
            handlers: [{ id: 'PreToolUse-2-handler-1', type: 'http' }],
          },
        ],
      },
    })
  })

  it('reports path diagnostics for duplicate ids and invalid source policy', async () => {
    const { parse } = await v2Api()
    const parsed = parse(
      {
        version: 2,
        policy: { maxConcurrency: 8 },
        hooks: {
          Stop: [
            {
              id: 'duplicate',
              handlers: [
                { id: 'same', type: 'command', command: 'true' },
                { id: 'same', type: 'command', command: 'true' },
              ],
            },
            {
              id: 'duplicate',
              handlers: [{ id: 'other', type: 'command', command: 'true' }],
            },
          ],
          NotARealEvent: [
            {
              id: 'bad',
              handlers: [
                { id: 'bad-handler', type: 'command', command: 'true' },
              ],
            },
          ],
        },
      },
      { sourceKind: 'project' },
    )

    expect(parsed.diagnostics.map((item) => [item.code, item.path])).toEqual(
      expect.arrayContaining([
        ['policy_not_allowed', 'policy'],
        ['duplicate_handler_id', 'hooks.Stop.0.handlers.1.id'],
        ['duplicate_group_id', 'hooks.Stop.1.id'],
        ['invalid_event', 'hooks.NotARealEvent'],
      ]),
    )
    expect((parsed.config.hooks as Dict).NotARealEvent).toBeUndefined()
  })

  it('validates outputs against the active event capabilities', async () => {
    const { parseOutput } = await v2Api()

    const preTool = parseOutput('PreToolUse', {
      decision: 'allow',
      reason: 'normalized',
      additionalContext: 'context',
      updatedInput: { path: 'README.md' },
    })
    const stop = parseOutput('Stop', {
      continue: false,
      stopReason: 'finished',
    })
    const invalid = parseOutput('SessionEnd', {
      decision: 'deny',
      updatedInput: { value: true },
    })

    expect(preTool.diagnostics).toEqual([])
    expect(preTool.output).toMatchObject({
      decision: 'allow',
      updatedInput: { path: 'README.md' },
    })
    expect(stop).toMatchObject({
      output: { continue: false, stopReason: 'finished' },
      diagnostics: [],
    })
    expect(invalid.output).toBeNull()
    expect(invalid.diagnostics.map((item) => item.code)).toContain(
      'invalid_hook_output',
    )
  })

  it('serializes normalized config deterministically and round-trips it', async () => {
    const { parse, serialize } = await v2Api()
    const parsed = parse({
      version: 2,
      hooks: {
        Stop: [
          {
            id: 'z-last',
            handlers: [{ id: 'z', type: 'command', command: 'true' }],
          },
        ],
        PreToolUse: [
          {
            id: 'a-first',
            matcher: 'read_file',
            handlers: [{ id: 'a', type: 'prompt', prompt: 'Check.' }],
          },
        ],
      },
    })
    const serializedA = serialize(parsed.config)
    const serializedB = serialize(parsed.config)
    const reparsed = parse(serializedA)

    expect(JSON.stringify(serializedA)).toBe(JSON.stringify(serializedB))
    expect(reparsed.diagnostics).toEqual([])
    expect(reparsed.config).toEqual(parsed.config)
  })

  it('uses safe deterministic defaults', async () => {
    const { defaultConfig, parse } = await v2Api()
    const config = defaultConfig()

    expect(config).toMatchObject({
      version: 2,
      enabled: true,
      projectHooks: { enabled: false },
      policy: {
        maxConcurrency: 4,
        maxContextBytes: 8_192,
        command: { allowShell: false, maxOutputBytes: 65_536 },
        http: {
          allowedUrlPatterns: [],
          maxResponseBytes: 1_048_576,
          allowLoopback: false,
        },
      },
      hooks: {},
    })
    expect(parse(null)).toEqual({ config, diagnostics: [] })
  })
})
