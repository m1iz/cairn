import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HookAuditStore } from './audit'
import type { HookAuditRunRecordV2 } from './orchestrator'

function record(
  id: string,
  startedAt: string,
  reason = 'ok',
): HookAuditRunRecordV2 {
  return {
    hookRunId: id,
    eventName: 'PreToolUse',
    groupId: 'guard',
    handlerId: 'command-1',
    handlerType: 'command',
    source: {
      id: 'global',
      kind: 'global',
      rank: 100,
      path: '/state/hooks.json',
      readonly: false,
      revision: 'source-r1',
      active: true,
      blockedReason: null,
    },
    snapshotRevision: 'snapshot-r1',
    sessionId: 'session-1',
    toolUseId: 'tool-1',
    startedAt,
    durationMs: 3,
    status: 'completed',
    outcome: 'deny',
    reason,
    inputHash: 'input-hash',
    outputHash: 'output-hash',
    asyncRewakeEligible: false,
  }
}

describe('HookAuditStore v2', () => {
  it('writes daily JSONL records with hashes and default reason redaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-audit-v2-'))
    try {
      const store = new HookAuditStore(root)
      await store.appendRun(
        record(
          'run-1',
          '2026-07-09T23:59:00.000Z',
          'token=top-secret password=hunter2',
        ),
      )
      await store.appendRun(record('run-2', '2026-07-10T00:01:00.000Z'))

      expect((await readdir(store.auditDir)).sort()).toEqual([
        '2026-07-09.jsonl',
        '2026-07-10.jsonl',
      ])
      const raw = await readFile(
        join(store.auditDir, '2026-07-09.jsonl'),
        'utf8',
      )
      expect(raw).toContain('"inputHash":"input-hash"')
      expect(raw).toContain('token=[REDACTED]')
      expect(raw).not.toContain('top-secret')
      expect(raw).not.toContain('hunter2')
      expect(raw).not.toContain('tool_input')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replays newest daily records with corrupt-line isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-audit-v2-replay-'))
    try {
      const store = new HookAuditStore(root)
      await store.appendRun(record('run-1', '2026-07-09T23:59:00.000Z'))
      await store.appendRun(record('run-2', '2026-07-10T00:01:00.000Z'))
      await writeFile(join(store.auditDir, '2026-07-10.jsonl'), 'not-json\n', {
        flag: 'a',
      })

      const replay = await store.replayRuns({ limit: 1 })

      expect(replay.records.map((entry) => entry.hookRunId)).toEqual(['run-2'])
      expect(replay.badLines).toEqual([
        {
          path: join(store.auditDir, '2026-07-10.jsonl'),
          line: 2,
          raw: 'not-json',
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
