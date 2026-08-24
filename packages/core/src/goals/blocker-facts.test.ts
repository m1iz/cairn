import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoreGoalBlockerCauseWriter } from '../agent/goal-blocker-cause-writer-internal'
import { CoreGoalBlockerFactIssuer } from '../agent/goal-blocker-fact-internal'
import { GoalBlockerCauseLedger } from './blocker-cause-ledger'
import {
  GoalBlockerFactStore,
  goalBlockReasonSha256,
  type GoalBlockerCause,
} from './blocker-facts'
import { GoalStore } from './store'
import { GoalContractValidator, newGoalRecord } from './validation'

describe('GoalBlockerFactStore', () => {
  it('binds a typed Core blocker to a persisted cause, reason hash, and exact Goal event seq', async () => {
    const fixture = await blockerFixture('goal_blocker_fact')
    const reason = 'Required upstream service is unavailable.'
    recordCause(fixture, 'external_dependency')
    const fact = issuer(fixture).issue(fixture.goal, {
      code: 'external_dependency',
      reason,
    })

    expect(fixture.facts.inspect(fixture.goal)).toEqual(fact)
    expect(fact).toMatchObject({
      kind: 'core_goal_blocker',
      goalId: fixture.goal.id,
      goalEventSeq: fixture.goal.lastEventSeq,
      code: 'external_dependency',
      reasonSha256: goalBlockReasonSha256(reason),
      evidenceReceiptId: 'cause_receipt_external_dependency',
    })
    expect(fact.evidenceVersion).toMatch(/^cause:[a-f0-9]{64}$/)
    expect(fact.version).toMatch(/^blocker:[a-f0-9]{64}$/)
    expect(fact.integritySha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('fails closed for a stale Goal event sequence or tampered blocker evidence', async () => {
    const fixture = await blockerFixture('goal_blocker_stale')
    recordCause(fixture, 'missing_access')
    issuer(fixture).issue(fixture.goal, {
      code: 'missing_access',
      reason: 'Repository access is denied.',
    })
    const advanced = await fixture.store.append(fixture.goal.id, {
      type: 'goal_updated',
      record: { ...fixture.goal, updatedAt: '2026-07-16T06:03:00.000Z' },
      expectedLastEventSeq: fixture.goal.lastEventSeq,
    })
    expect(fixture.facts.inspect(advanced)).toBeNull()

    const raw = JSON.parse(readFileSync(fixture.facts.path, 'utf8'))
    raw.facts[fixture.goal.id].evidenceVersion = 'forged:other'
    writeFileSync(fixture.facts.path, JSON.stringify(raw, null, 2), 'utf8')
    expect(fixture.facts.inspect(fixture.goal)).toBeNull()
  })

  it('has no public issuer/raw record API and rejects mismatched, caller, or verification-failure causes', async () => {
    const fixture = await blockerFixture('goal_blocker_issuer')
    expect(
      (fixture.facts as unknown as { record?: unknown }).record,
    ).toBeUndefined()
    expect(
      (fixture.facts as unknown as { createIssuer?: unknown }).createIssuer,
    ).toBeUndefined()

    recordCause(fixture, 'missing_permission')
    await expect(
      Promise.resolve().then(() =>
        issuer(fixture).issue(fixture.goal, {
          code: 'missing_access',
          reason: 'The repository is unavailable.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'goal_blocker_cause_untrusted' })

    const arbitrary = await blockerFixture('goal_blocker_arbitrary')
    await expect(
      Promise.resolve().then(() =>
        issuer(arbitrary).issue(arbitrary.goal, {
          code: 'missing_access',
          reason: 'The repository is unavailable.',
          evidenceReceiptId: 'caller_supplied_evidence',
        } as never),
      ),
    ).rejects.toMatchObject({ code: 'goal_blocker_cause_untrusted' })

    const verification = await blockerFixture('goal_blocker_verification')
    recordCause(verification, 'verification_failure')
    await expect(
      Promise.resolve().then(() =>
        issuer(verification).issue(verification.goal, {
          code: 'external_dependency',
          reason: 'An operation could not finish.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'goal_block_verification_failure' })
  })
})

function issuer(fixture: Awaited<ReturnType<typeof blockerFixture>>) {
  return CoreGoalBlockerFactIssuer.create({
    store: fixture.facts,
    causeLedger: fixture.causes,
  })
}

function recordCause(
  fixture: Awaited<ReturnType<typeof blockerFixture>>,
  cause: GoalBlockerCause,
): void {
  fixture.causeWriter.record(fixture.goal, cause, `cause_receipt_${cause}`)
}

async function blockerFixture(goalId: string) {
  const root = mkdtempSync(join(tmpdir(), 'cairn-goal-blocker-fact-'))
  const store = new GoalStore(root)
  const created = await store.create(
    newGoalRecord({
      id: goalId,
      outcome: 'Validate typed blocker facts.',
      scope: {
        sessionId: `session_${goalId}`,
        mode: 'build',
        projectId: 'project_blocker',
        workspaceRoot: '/workspace/blocker',
      },
      now: '2026-07-16T06:00:00.000Z',
    }),
  )
  const goal = await store.append(goalId, {
    type: 'goal_updated',
    record: GoalContractValidator.lock(
      created,
      {
        inScope: ['typed blocker facts'],
        outOfScope: [],
        constraints: [],
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'Blocker fact remains exact.',
            required: true,
            verification: { kind: 'manual', requirement: 'inspect receipt' },
          },
        ],
        escalationConditions: [],
      },
      '2026-07-16T06:01:00.000Z',
    ),
    expectedLastEventSeq: created.lastEventSeq,
  })
  const causes = new GoalBlockerCauseLedger(root)
  return {
    root,
    store,
    goal,
    facts: new GoalBlockerFactStore(root),
    causes,
    causeWriter: CoreGoalBlockerCauseWriter.create(causes),
  }
}
