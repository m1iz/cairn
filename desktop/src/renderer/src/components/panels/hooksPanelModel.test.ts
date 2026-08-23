import { describe, expect, it } from 'vitest'
import type { HooksPayload } from '../../types'
import {
  auditQuery,
  cancellableRunIds,
  dryRunInput,
  effectiveHookRows,
  hooksTrustTone,
  isStaleHooksError,
} from './hooksPanelModel'

describe('hooks panel model', () => {
  it('projects effective groups with provenance and blocked state', () => {
    const payload = {
      effectiveGroups: [
        {
          eventName: 'PreToolUse',
          group: {
            id: 'guard-write',
            enabled: true,
            matcher: 'write_file',
            if: '',
            failureMode: 'closed',
            handlers: [{ id: 'command-1', type: 'command', enabled: true }],
          },
          source: {
            id: 'project',
            kind: 'project',
            path: '/repo/.cairn/settings.json',
            readonly: true,
            active: false,
            blockedReason: 'project_untrusted',
          },
        },
        {
          eventName: 'Stop',
          group: {
            id: 'completion',
            enabled: true,
            matcher: '*',
            if: '',
            failureMode: 'open',
            handlers: [
              { id: 'prompt-1', type: 'prompt', enabled: true },
              { id: 'agent-1', type: 'agent', enabled: false },
            ],
          },
          source: {
            id: 'global',
            kind: 'global',
            path: '/state/hooks_config.json',
            readonly: false,
            active: true,
            blockedReason: null,
          },
        },
      ],
    } as HooksPayload

    expect(effectiveHookRows(payload)).toEqual([
      expect.objectContaining({
        eventName: 'PreToolUse',
        groupId: 'guard-write',
        handlerCount: 1,
        sourceKind: 'project',
        readonly: true,
        active: false,
        blockedReason: 'project_untrusted',
      }),
      expect.objectContaining({
        eventName: 'Stop',
        groupId: 'completion',
        handlerCount: 2,
        enabledHandlerCount: 1,
        sourceKind: 'global',
        readonly: false,
        active: true,
      }),
    ])
  })

  it('classifies project trust without treating stale trust as trusted', () => {
    expect(hooksTrustTone('trusted')).toBe('ok')
    expect(hooksTrustTone('untrusted')).toBe('warn')
    expect(hooksTrustTone('stale')).toBe('error')
    expect(hooksTrustTone(null)).toBe('muted')
  })

  it('builds event-specific dry-run input from metadata matcher fields', () => {
    expect(dryRunInput('PreToolUse', 'tool_name')).toEqual({
      tool_name: 'read_file',
      tool_input: { path: 'README.md' },
      tool_use_id: 'dry-run',
    })
    expect(dryRunInput('Stop', null)).toEqual({ reason: 'completed' })
    expect(dryRunInput('ConfigChange', 'source')).toEqual({
      source: 'hooks.testMatch',
      candidate_revision: 'dry-run',
    })
    expect(dryRunInput('SubagentStart', 'agent_type')).toEqual({
      agent_type: 'general-purpose',
      agent_id: 'dry-run-agent',
    })
  })

  it('normalizes audit filters and stale revision errors', () => {
    expect(
      auditQuery({
        eventName: 'PreToolUse',
        outcome: '',
        sourceId: 'project',
        cursor: '20',
      }),
    ).toEqual({
      limit: 50,
      eventName: 'PreToolUse',
      sourceId: 'project',
      cursor: '20',
    })
    expect(
      isStaleHooksError(
        new Error('stale hooks revision: expected old, current new'),
      ),
    ).toBe(true)
    expect(isStaleHooksError(new Error('validation failed'))).toBe(false)
  })

  it('finds cancellable async runs in test execution results', () => {
    expect(
      cancellableRunIds({
        results: [
          { hookRunId: 'hook_run_1', asyncRewakeEligible: true },
          { hookRunId: 'hook_run_2', asyncRewakeEligible: false },
          { hookId: 'legacy' },
        ],
      }),
    ).toEqual(['hook_run_1'])
  })
})
