import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { newGoalRecord } from './validation'
import { GoalGateFactStore } from './gate-facts'
import { GoalGateCoreFactAdapters } from './gate-fact-adapters'
import { GoalStore } from './store'
import { ControlStore } from '../control/store'
import { GoalGateMutationLedger } from './mutation-ledger'

describe('GoalGateFactStore', () => {
  it('persists integrity-bound Core facts for the exact Goal event sequence', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-gate-facts-'))
    const goal = {
      ...factGoal('goal_facts'),
      lastEventSeq: 4,
    }
    const store = new GoalGateFactStore(root)

    store.recordBundle(goal, {
      runtime: { pendingInteractionId: null, directlyAnswerable: false },
      scope: { matches: true },
      storage: { healthy: true },
      hardConstraints: { satisfied: true },
      cost: { estimatedCostUsd: 1.25 },
    })

    expect(store.inspectBundle(goal)).toMatchObject({
      runtime: {
        value: { pendingInteractionId: null, directlyAnswerable: false },
      },
      scope: { value: { matches: true } },
      storage: { value: { healthy: true } },
      hardConstraints: { value: { satisfied: true } },
      cost: { value: { estimatedCostUsd: 1.25 } },
    })
    expect(store.inspectBundle({ ...goal, lastEventSeq: 5 })).toEqual({
      runtime: null,
      scope: null,
      storage: null,
      hardConstraints: null,
      cost: null,
    })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
    'rejects invalid estimated cost %s before persistence',
    (estimatedCostUsd) => {
      const root = mkdtempSync(join(tmpdir(), 'cairn-goal-gate-facts-'))
      const store = new GoalGateFactStore(root)
      const goal = factGoal('goal_cost')

      expect(() =>
        store.recordBundle(goal, {
          cost: { estimatedCostUsd },
        }),
      ).toThrowError(
        expect.objectContaining({ code: 'goal_gate_fact_invalid' }),
      )
    },
  )

  it('fails closed for missing or integrity-corrupt facts without repairing disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-gate-facts-'))
    const store = new GoalGateFactStore(root)
    const goal = factGoal('goal_corrupt')
    expect(store.inspectBundle(goal).scope).toBeNull()
    store.recordBundle(goal, { scope: { matches: true } })
    const before = readFileSync(store.path, 'utf8')
    writeFileSync(
      store.path,
      before.replace('"matches":true', '"matches":false'),
    )

    expect(store.inspectBundle(goal).scope).toBeNull()
    expect(readFileSync(store.path, 'utf8')).toBe(
      before.replace('"matches":true', '"matches":false'),
    )
  })

  it('adapts concrete Core scope, storage, Control runtime, constraints, and cost', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-gate-facts-'))
    const goalStore = new GoalStore(root)
    const goal = await goalStore.create(factGoal('goal_adapters'))
    const factStore = new GoalGateFactStore(root)
    const adapters = new GoalGateCoreFactAdapters(
      factStore,
      goalStore,
      new ControlStore(root),
    )

    const facts = await adapters.refresh(goal, {
      currentScope: goal.scope,
      hardConstraintsSatisfied: true,
      estimatedCostUsd: 0,
    })

    expect(facts).toMatchObject({
      runtime: { value: { pendingInteractionId: null } },
      scope: { value: { matches: true } },
      storage: { value: { healthy: true } },
      hardConstraints: { value: { satisfied: true } },
      cost: { value: { estimatedCostUsd: 0 } },
    })
  })

  it('inspects live facts without creating the fact document or advancing the epoch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-live-facts-'))
    const goalStore = new GoalStore(root)
    const goal = await goalStore.create(factGoal('goal_live_facts'))
    const factStore = new GoalGateFactStore(root)
    const adapters = new GoalGateCoreFactAdapters(
      factStore,
      goalStore,
      new ControlStore(root),
    )
    const mutations = new GoalGateMutationLedger(root)
    const before = mutations.inspect()

    const facts = await adapters.inspectLiveBundle(goal, {
      currentScope: goal.scope,
      hardConstraintsSatisfied: true,
      estimatedCostUsd: 0,
    })

    expect(facts.runtime?.value.pendingInteractionId).toBeNull()
    expect(facts.storage?.value.healthy).toBe(true)
    expect(mutations.inspect()).toEqual(before)
    expect(() => readFileSync(factStore.path)).toThrow()
  })

  it('does not let an unrelated Goal diagnostic poison a healthy Goal storage fact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-local-storage-'))
    const goal = factGoal('goal_healthy')
    const adapters = new GoalGateCoreFactAdapters(
      new GoalGateFactStore(root),
      {
        async inspect() {
          return { record: goal, issue: null }
        },
        async diagnostics() {
          return {
            root: join(root, 'goals'),
            issues: [
              {
                goalId: 'goal_unrelated',
                code: 'event_corrupt' as const,
                path: join(root, 'goals', 'goal_unrelated', 'events.jsonl'),
                recovered: false,
              },
            ],
            recoveryRequired: 1,
            indexRebuilt: false,
            indexCorruptBackup: null,
            observationCorruptions: [],
            deleteFailures: [
              { sessionId: 'session_other', goalId: 'goal_unrelated' },
            ],
          }
        },
      },
      new ControlStore(root),
    )

    const facts = await adapters.inspectLiveBundle(goal, {
      currentScope: goal.scope,
    })

    expect(facts.storage?.value.healthy).toBe(true)
  })

  it('fails closed without minting a trusted default runtime fact when Control bytes are corrupt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-gate-facts-'))
    const goalStore = new GoalStore(root)
    const goal = await goalStore.create(factGoal('goal_control_corrupt'))
    const controlStore = new ControlStore(root)
    writeFileSync(controlStore.stateFile, '{corrupt control', 'utf8')
    const before = readFileSync(controlStore.stateFile)
    const factStore = new GoalGateFactStore(root)
    const adapters = new GoalGateCoreFactAdapters(
      factStore,
      goalStore,
      controlStore,
    )

    const facts = await adapters.refresh(goal)

    expect(facts.runtime).toBeNull()
    expect(facts.storage?.value.healthy).toBe(false)
    expect(readFileSync(controlStore.stateFile)).toEqual(before)
  })
})

function factGoal(id: string) {
  return newGoalRecord({
    id,
    outcome: 'Persist trusted Gate facts.',
    scope: {
      sessionId: `session_${id}`,
      mode: 'build',
      projectId: null,
      workspaceRoot: '/workspace/facts',
    },
    now: '2026-07-16T00:00:00.000Z',
  })
}
