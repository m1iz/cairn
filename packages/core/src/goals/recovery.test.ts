import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { GoalRecord } from './models'
import {
  GoalContractValidator,
  assertGoalTransition,
  newGoalRecord,
} from './validation'
import { computeGoalEventHash, type GoalEventEnvelope } from './events'
import { GoalRecoveryService } from './recovery'
import { GoalStore } from './store'

const T0 = '2026-07-15T11:00:00.000Z'
const T1 = '2026-07-15T11:01:00.000Z'
const T2 = '2026-07-15T11:02:00.000Z'
const T3 = '2026-07-15T11:03:00.000Z'
const T4 = '2026-07-15T11:04:00.000Z'

let stateRoot: string

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'cairn-goal-recovery-'))
})

describe('GoalRecoveryService', () => {
  it('replays only events beyond a stale snapshot without applying any event twice', async () => {
    const store = new GoalStore(stateRoot)
    let record = await store.create(draft('goal_stale', 'session-stale'))
    record = await lock(store, record, T1)
    const stale = record
    record = await move(store, record, 'executing', T2)
    await writeFile(
      snapshotPath(record.id),
      `${JSON.stringify(stale)}\n`,
      'utf8',
    )

    const restarted = new GoalStore(stateRoot)
    const rebuilt = await restarted.rebuildSnapshot(record.id)

    expect(rebuilt).toEqual(record)
    expect(rebuilt?.lastEventSeq).toBe(3)
    expect((await restarted.diagnostics()).issues).toContainEqual(
      expect.objectContaining({
        goalId: record.id,
        code: 'snapshot_stale',
        recovered: true,
      }),
    )
  })

  it('rebuilds a completely missing snapshot from the event ledger', async () => {
    const store = new GoalStore(stateRoot)
    let record = await store.create(draft('goal_missing', 'session-missing'))
    record = await lock(store, record, T1)
    await rm(snapshotPath(record.id))

    const rebuilt = await new GoalStore(stateRoot).rebuildSnapshot(record.id)

    expect(rebuilt).toEqual(record)
  })

  it('fails closed on a bad JSONL line and records event corruption diagnostics', async () => {
    const store = new GoalStore(stateRoot)
    let record = await store.create(draft('goal_bad_line', 'session-bad-line'))
    record = await lock(store, record, T1)
    record = await move(store, record, 'executing', T2)
    await appendFile(eventsPath(record.id), '{bad-event\n', 'utf8')

    const restarted = new GoalStore(stateRoot)
    const result = await new GoalRecoveryService(restarted, {
      now: () => T3,
    }).recoverOnStartup()
    const safe = await restarted.get(record.id)

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        goalId: record.id,
        code: 'event_corrupt',
        recovered: false,
      }),
    )
    expect(safe).toMatchObject({
      status: 'active',
      runtime: { phase: 'paused', pauseReason: 'recovery_required' },
    })
    await expect(
      restarted.append(record.id, {
        type: 'goal_updated',
        record: safe!,
        createdAt: T4,
      }),
    ).rejects.toMatchObject({ code: 'storage_recovery_required' })
  })

  it('fails closed when a middle event hash is modified', async () => {
    const store = new GoalStore(stateRoot)
    let record = await store.create(draft('goal_hash', 'session-hash'))
    record = await lock(store, record, T1)
    record = await move(store, record, 'executing', T2)
    record = await move(store, record, 'verifying', T3)
    const events = await readEvents(record.id)
    events[2] = {
      ...events[2]!,
      payload: { ...events[2]!.payload, tampered: true },
    }
    await writeFile(
      eventsPath(record.id),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    )

    const restarted = new GoalStore(stateRoot)
    const result = await new GoalRecoveryService(restarted, {
      now: () => T4,
    }).recoverOnStartup()
    const safe = await restarted.get(record.id)

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        goalId: record.id,
        code: 'hash_chain_broken',
        recovered: false,
      }),
    )
    expect(safe?.runtime).toMatchObject({
      phase: 'paused',
      pauseReason: 'recovery_required',
    })
  })

  it('fails closed when valid JSON decodes to a non-finite event value', async () => {
    const store = new GoalStore(stateRoot)
    let record = await store.create(
      draft('goal_non_finite_json', 'session-non-finite-json'),
    )
    record = await lock(store, record, T1)
    const executing = assertGoalTransition(record, {
      ...record,
      runtime: { ...record.runtime, phase: 'executing' },
      updatedAt: T2,
    })
    await store.append(record.id, {
      type: 'goal_updated',
      record: executing,
      createdAt: T2,
      data: { strictNumber: 1 },
    })
    const path = eventsPath(record.id)
    const original = await readFile(path, 'utf8')
    const malformed = original.replace(
      '"strictNumber":1',
      '"strictNumber":1e400',
    )
    expect(malformed).not.toBe(original)
    await writeFile(path, malformed, 'utf8')

    const restarted = new GoalStore(stateRoot, { now: () => T3 })
    const recovery = new GoalRecoveryService(restarted, { now: () => T3 })
    const result = await recovery.recoverOnStartup()
    const safe = await restarted.get(record.id)

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        goalId: record.id,
        code: 'event_corrupt',
        recovered: false,
      }),
    )
    expect(safe).toMatchObject({
      status: 'active',
      runtime: { phase: 'paused', pauseReason: 'recovery_required' },
      lastEventSeq: 2,
    })
    await expect(
      restarted.append(record.id, {
        type: 'goal_updated',
        record: safe!,
        createdAt: T4,
      }),
    ).rejects.toMatchObject({ code: 'storage_recovery_required' })
  })

  it('pauses orphaned verifying work but preserves an executing Goal with an active runtime', async () => {
    const store = new GoalStore(stateRoot)
    let orphaned = await store.create(
      draft('goal_orphaned', 'session-orphaned'),
    )
    orphaned = await lock(store, orphaned, T1)
    orphaned = await move(store, orphaned, 'executing', T2)
    orphaned = await move(store, orphaned, 'verifying', T3)
    let live = await store.create(draft('goal_live', 'session-live'))
    live = await lock(store, live, T1)
    live = await move(store, live, 'executing', T2)

    const restarted = new GoalStore(stateRoot)
    const result = await new GoalRecoveryService(restarted, {
      hasActiveRuntime: (goal) => goal.id === live.id,
      now: () => T4,
    }).recoverOnStartup()

    expect(await restarted.get(orphaned.id)).toMatchObject({
      status: 'active',
      runtime: { phase: 'paused', pauseReason: 'recovery_required' },
      lastEventSeq: 5,
    })
    expect(await restarted.get(live.id)).toEqual(live)
    expect(result.pausedGoalIds).toEqual([orphaned.id])
  })

  it('does not auto-resume planning or already paused Goals', async () => {
    const store = new GoalStore(stateRoot)
    let planning = await store.create(
      draft('goal_planning', 'session-planning'),
    )
    planning = await lock(store, planning, T1)
    let paused = await store.create(draft('goal_paused', 'session-paused'))
    paused = await lock(store, paused, T1)
    paused = await move(store, paused, 'executing', T2)
    paused = await move(store, paused, 'paused', T3, 'user_requested')

    const restarted = new GoalStore(stateRoot)
    const result = await new GoalRecoveryService(restarted, {
      now: () => T4,
    }).recoverOnStartup()

    expect(await restarted.get(planning.id)).toEqual(planning)
    expect(await restarted.get(paused.id)).toEqual(paused)
    expect(result.pausedGoalIds).toEqual([])
  })

  it('fails closed when startup scope validation finds a missing workspace or binding drift', async () => {
    const store = new GoalStore(stateRoot)
    let missingWorkspace = await store.create(
      draft('goal_workspace_missing', 'session-workspace-missing'),
    )
    missingWorkspace = await lock(store, missingWorkspace, T1)
    let bindingDrift = await store.create(
      draft('goal_binding_drift', 'session-binding-drift'),
    )
    bindingDrift = await lock(store, bindingDrift, T1)
    bindingDrift = await move(store, bindingDrift, 'executing', T2)
    bindingDrift = await move(
      store,
      bindingDrift,
      'paused',
      T3,
      'user_requested',
    )
    let valid = await store.create(
      draft('goal_scope_valid', 'session-scope-valid'),
    )
    valid = await lock(store, valid, T1)

    const restarted = new GoalStore(stateRoot, { now: () => T4 })
    const result = await new GoalRecoveryService(restarted, {
      now: () => T4,
      validateScope: (goal) => {
        if (goal.id === missingWorkspace.id)
          return { valid: false, reason: 'workspace_missing' }
        if (goal.id === bindingDrift.id)
          return { valid: false, reason: 'binding_drift' }
        return { valid: true }
      },
    }).recoverOnStartup()

    for (const record of [missingWorkspace, bindingDrift]) {
      expect(await restarted.get(record.id)).toMatchObject({
        status: 'active',
        runtime: { phase: 'paused', pauseReason: 'recovery_required' },
      })
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          goalId: record.id,
          code: 'scope_missing',
          recovered: false,
        }),
      )
      await expect(
        restarted.append(record.id, {
          type: 'goal_updated',
          record: (await restarted.get(record.id))!,
          createdAt: T4,
        }),
      ).rejects.toMatchObject({ code: 'storage_recovery_required' })
    }
    expect(await restarted.get(valid.id)).toEqual(valid)
  })

  it('classifies a ledger scope fingerprint mismatch as scope_missing', async () => {
    const store = new GoalStore(stateRoot)
    let record = await store.create(
      draft('goal_ledger_scope_mismatch', 'session-ledger-scope-mismatch'),
    )
    record = await lock(store, record, T1)
    const events = await readEvents(record.id)
    const modified = {
      ...events[1]!,
      payload: {
        ...events[1]!.payload,
        record: {
          ...(events[1]!.payload.record as GoalRecord),
          scope: {
            ...(events[1]!.payload.record as GoalRecord).scope,
            projectFingerprint: '0'.repeat(64),
          },
        },
      },
    }
    events[1] = { ...modified, hash: computeGoalEventHash(modified) }
    await writeFile(
      eventsPath(record.id),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    )

    const restarted = new GoalStore(stateRoot)
    const result = await new GoalRecoveryService(restarted).recoverOnStartup()

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        goalId: record.id,
        code: 'scope_missing',
        recovered: false,
      }),
    )
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ goalId: record.id, code: 'event_corrupt' }),
    )
  })

  it('reports a scope_missing boundary without inventing a Goal snapshot', async () => {
    const store = new GoalStore(stateRoot)
    await store.create(draft('goal_valid', 'session-valid'))
    const emptyGoalRoot = join(stateRoot, 'goals', 'goal_scope_missing')
    await mkdir(emptyGoalRoot, { recursive: true })
    await writeFile(join(emptyGoalRoot, 'events.jsonl'), '', 'utf8')

    const restarted = new GoalStore(stateRoot)
    const result = await new GoalRecoveryService(restarted).recoverOnStartup()

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        goalId: 'goal_scope_missing',
        code: 'scope_missing',
        recovered: false,
      }),
    )
    expect(await restarted.get('goal_scope_missing')).toBeNull()
    await expect(
      restarted.create(draft('goal_after_scope_loss', 'session-new')),
    ).rejects.toMatchObject({ code: 'storage_recovery_required' })
  })
})

function draft(id: string, sessionId: string): GoalRecord {
  return newGoalRecord({
    id,
    outcome: 'Recover durable work',
    scope: {
      sessionId,
      mode: 'build',
      projectId: 'project-recovery',
      workspaceRoot: join(stateRoot, 'workspace'),
    },
    now: T0,
  })
}

function definition() {
  return {
    inScope: ['Recovery'],
    outOfScope: [],
    constraints: ['Do not auto resume'],
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'Recovery is safe',
        required: true,
        verification: { kind: 'command' as const, requirement: 'npm test' },
      },
    ],
    escalationConditions: [],
  }
}

async function lock(
  store: GoalStore,
  current: GoalRecord,
  at: string,
): Promise<GoalRecord> {
  return store.append(current.id, {
    type: 'goal_updated',
    record: GoalContractValidator.lock(current, definition(), at),
    createdAt: at,
  })
}

async function move(
  store: GoalStore,
  current: GoalRecord,
  phase: GoalRecord['runtime']['phase'],
  at: string,
  pauseReason: string | null = null,
): Promise<GoalRecord> {
  const next = assertGoalTransition(current, {
    ...current,
    runtime: { ...current.runtime, phase, pauseReason },
    updatedAt: at,
  })
  return store.append(current.id, {
    type:
      phase === 'paused' && pauseReason === 'recovery_required'
        ? 'goal_recovery_paused'
        : 'goal_updated',
    record: next,
    createdAt: at,
  })
}

function snapshotPath(goalId: string): string {
  return join(stateRoot, 'goals', goalId, 'goal.json')
}

function eventsPath(goalId: string): string {
  return join(stateRoot, 'goals', goalId, 'events.jsonl')
}

async function readEvents(goalId: string): Promise<GoalEventEnvelope[]> {
  return (await readFile(eventsPath(goalId), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as GoalEventEnvelope)
}
