import { describe, expect, it } from 'vitest'

type Dict = Record<string, unknown>
type Plan = {
  items: Array<{ groupId: string; handlerId: string }>
  diagnostics: Array<{ code: string; path: string }>
}
type Compile = (snapshot: Dict, input: Dict) => Plan

async function compiler(): Promise<Compile> {
  const module = (await import('./matcher')) as unknown as Record<
    string,
    unknown
  >
  expect(module.compileHookPlan).toBeTypeOf('function')
  return module.compileHookPlan as Compile
}

function snapshot(
  groups: Array<{ eventName: string; group: Dict; source?: Dict }>,
): Dict {
  return {
    revision: 'snapshot-test',
    groups: groups.map((item, index) => ({
      ...item,
      source: item.source ?? {
        id: `source-${index}`,
        kind: 'global',
        rank: 100,
        active: true,
      },
    })),
  }
}

function group(
  id: string,
  matcher: string,
  handlers: Dict[],
  condition = '',
): Dict {
  return {
    id,
    enabled: true,
    matcher,
    if: condition,
    failureMode: 'open',
    handlers,
  }
}

function command(id: string): Dict {
  return { id, enabled: true, type: 'command', command: 'true' }
}

describe('hooks v2 matcher compiler', () => {
  it('uses tool_name for PermissionRequest and preserves stable plan order', async () => {
    const compile = await compiler()
    const plan = compile(
      snapshot([
        {
          eventName: 'PermissionRequest',
          group: group('all', '*', [command('first')]),
        },
        {
          eventName: 'PermissionRequest',
          group: group('pipe', 'read_file|write_file', [command('second')]),
        },
        {
          eventName: 'PermissionRequest',
          group: group('miss', 'grep', [command('third')]),
        },
      ]),
      {
        hook_event_name: 'PermissionRequest',
        session_id: 's1',
        cwd: '/repo',
        state_root: '/state',
        tool_name: 'write_file',
        tool_input: { path: 'README.md' },
        tool_use_id: 'call-1',
        permission: {},
      },
    )

    expect(plan.items.map((item) => [item.groupId, item.handlerId])).toEqual([
      ['all', 'first'],
      ['pipe', 'second'],
    ])
  })

  it('supports regex, Tool conditions, and path globs', async () => {
    const compile = await compiler()
    const plan = compile(
      snapshot([
        {
          eventName: 'PreToolUse',
          group: group('regex', '/^write_/i', [command('regex-handler')]),
        },
        {
          eventName: 'PreToolUse',
          group: group(
            'tool-if',
            '*',
            [command('tool-handler')],
            'Tool(write_*)',
          ),
        },
        {
          eventName: 'PreToolUse',
          group: group(
            'path-if',
            '*',
            [command('path-handler')],
            'path:src/**/*.ts',
          ),
        },
      ]),
      {
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        cwd: '/repo',
        state_root: '/state',
        tool_name: 'WRITE_FILE',
        tool_input: { path: 'src/hooks/index.ts' },
        tool_use_id: 'call-1',
      },
    )

    expect(plan.items.map((item) => item.groupId)).toEqual(['regex', 'path-if'])
  })

  it('diagnoses invalid regex and unsupported conditions without throwing', async () => {
    const compile = await compiler()
    const plan = compile(
      snapshot([
        {
          eventName: 'PreToolUse',
          group: group('bad-regex', '/(/', [command('bad-regex-handler')]),
        },
        {
          eventName: 'PreToolUse',
          group: group(
            'bad-if',
            '*',
            [command('bad-if-handler')],
            'Unknown(value)',
          ),
        },
      ]),
      {
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        cwd: '/repo',
        state_root: '/state',
        tool_name: 'write_file',
        tool_input: {},
        tool_use_id: 'call-1',
      },
    )

    expect(plan.items).toEqual([])
    expect(plan.diagnostics.map((item) => item.code)).toEqual([
      'invalid_matcher_regex',
      'unsupported_hook_condition',
    ])
  })

  it('filters handler types that the event capability does not allow', async () => {
    const compile = await compiler()
    const plan = compile(
      snapshot([
        {
          eventName: 'SessionStart',
          group: group('startup', '*', [
            command('command-handler'),
            {
              id: 'http-handler',
              enabled: true,
              type: 'http',
              url: 'https://hooks.example.test/start',
            },
          ]),
        },
      ]),
      {
        hook_event_name: 'SessionStart',
        session_id: 's1',
        cwd: '/repo',
        state_root: '/state',
        source: 'startup',
      },
    )

    expect(plan.items.map((item) => item.handlerId)).toEqual([
      'command-handler',
    ])
    expect(plan.diagnostics.map((item) => item.code)).toContain(
      'handler_not_allowed_for_event',
    )
  })
})
