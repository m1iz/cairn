import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoreGoalBlockerCauseWriter } from '../agent/goal-blocker-cause-writer-internal'
import { CoreGoalBlockerFactIssuer } from '../agent/goal-blocker-fact-internal'
import { createAuthorizedGoalCompletionGate } from '../agent/goal-completion-gate-internal'
import { GoalBlockerCauseLedger } from './blocker-cause-ledger'
import { GoalEvidenceLedger, type GoalEvidence } from './evidence'
import {
  GoalCompletionGate,
  type GoalCompletionGateOptions,
} from './completion-gate'
import {
  computeGoalPlanCompletionReceiptIntegrity,
  type GoalPlanCompletionReceipt,
} from './plan-bridge'
import { GoalStore } from './store'
import { GoalGateMutationLedger } from './mutation-ledger'
import { GoalPostCommitDiagnosticsStore } from './post-commit-diagnostics'
import { GoalGateFactStore } from './gate-facts'
import { GoalGateCoreFactAdapters } from './gate-fact-adapters'
import { GoalCleanupJournal } from './cleanup-journal'
import { ControlManager } from '../control/manager'
import {
  GoalBlockerFactStore,
  goalBlockReasonSha256,
  type GoalTypedBlockerCode,
} from './blocker-facts'
import {
  GoalContractValidator,
  assertGoalTransition,
  newGoalRecord,
} from './validation'

const T0 = '2026-07-16T02:00:00.000Z'
const T1 = '2026-07-16T02:01:00.000Z'
const T2 = '2026-07-16T02:02:00.000Z'
const T3 = '2026-07-16T02:03:00.000Z'
const T4 = '2026-07-16T02:04:00.000Z'

describe('GoalCompletionGate.evaluate', () => {
  it('is read-only and aggregates every stable reason in deterministic contract order', async () => {
    const fixture = await gateGoal('goal_gate_reasons', {
      maxCycles: 1,
      latestEvidenceByCriterion: {
        'AC-2': 'evidence_fail',
        'AC-3': 'evidence_corrupt',
      },
      cyclesUsed: 1,
    })
    const evidence = new Map<string, GoalEvidence | null>([
      ['evidence_fail', goalEvidence(fixture.goalId, 'AC-2', 'fail')],
      ['evidence_corrupt', null],
    ])
    const receipt = planReceipt({
      goalId: fixture.goalId,
      assessmentStatus: 'executing',
      completed: false,
      invalidReasons: [
        'plan_executing',
        'required_verification_incomplete',
        'plan_execution_blocked',
        'plan_intent_incomplete',
      ],
      executionBlocked: true,
      hasIncompleteIntent: true,
      steps: [
        planStep('step_pending', 'pending'),
        planStep('step_active', 'active'),
        planStep('step_failed', 'failed'),
        planStep('step_blocked', 'blocked'),
        planStep('step_skipped', 'skipped', false),
      ],
      reviewer: {
        required: true,
        satisfied: false,
        waived: false,
        riskSignals: ['backend'],
        evidenceSource: null,
      },
    })
    fixture.factStore.recordBundle(fixture.goal, {
      runtime: {
        pendingInteractionId: 'ask_gate',
        directlyAnswerable: true,
      },
      scope: { matches: false },
      storage: { healthy: false },
      hardConstraints: { satisfied: false },
      cost: { estimatedCostUsd: null },
    })
    let factReads = 0
    const gate = createAuthorizedGoalCompletionGate({
      goalStore: fixture.store,
      planBridge: {
        async planCompletionReceipt() {
          factReads += 1
          return receipt
        },
      },
      evidenceLedger: {
        async validatedEvidenceById(_goalId, evidenceId) {
          factReads += 1
          return evidence.get(evidenceId) ?? null
        },
      },
      reviewerLedger: {
        async latestReviewerDecision() {
          factReads += 1
          return {
            id: 'review_fail',
            goalId: fixture.goalId,
            planId: 'plan_gate',
            planEventSeq: 7,
            verdict: 'fail' as const,
            riskSignals: ['backend'],
            taskId: 'task_reviewer',
            dispatchReceiptId: 'dispatch_reviewer',
            dispatchOrdinal: 1,
            agentId: 'agent_reviewer',
            transcriptRef: 'task:task_reviewer:transcript',
            transcriptSha256: 'a'.repeat(64),
            commandEvidenceIds: ['evidence_fail'],
            commandObservationIds: ['observation_fail'],
            summary: 'Reviewer found a failure.',
            createdAt: T2,
            integritySha256: 'b'.repeat(64),
          }
        },
      },
      factStore: fixture.factStore,
      blockerFactStore: fixture.blockerFactStore,
      now: () => T3,
    })
    const before = await fixture.store.readEvents(fixture.goalId)

    const result = await gate.evaluate(fixture.goalId)

    expect(result.pass).toBe(false)
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      'plan_not_completed',
      'plan_step_incomplete',
      'plan_step_incomplete',
      'plan_step_failed',
      'plan_step_blocked',
      'plan_step_skipped_without_waiver',
      'plan_verification_incomplete',
      'plan_quarantined',
      'plan_intent_incomplete',
      'criterion_missing_evidence',
      'criterion_latest_failed',
      'criterion_evidence_invalid',
      'independent_verification_failed',
      'pending_interaction',
      'scope_mismatch',
      'storage_recovery_required',
      'hard_constraint_violation',
      'guard_policy_exceeded',
    ])
    expect(result.reasons).toContainEqual(
      expect.objectContaining({
        code: 'plan_step_incomplete',
        planStepId: 'step_pending',
      }),
    )
    expect(result.reasons[9]).toMatchObject({ criterionId: 'AC-1' })
    expect(result.riskDisclosures).toContainEqual({
      code: 'optional_criterion_missing_evidence',
      criterionId: 'AC-4',
    })
    expect(factReads).toBeGreaterThan(0)
    expect(await fixture.store.readEvents(fixture.goalId)).toEqual(before)
  })

  it('passes a low-risk Goal and discloses optional AC gaps without blocking', async () => {
    const fixture = await gateGoal('goal_gate_optional', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const gate = passingGate(fixture, {
      async validatedEvidenceById(goalId, evidenceId) {
        return evidenceId === 'evidence_pass'
          ? goalEvidence(goalId, 'AC-1', 'pass')
          : null
      },
    })

    const result = await gate.evaluate(fixture.goalId)

    expect(result.pass).toBe(true)
    expect(result.reasons).toEqual([])
    expect(result.evidenceIds).toEqual(['evidence_pass'])
    expect(result.riskDisclosures).toEqual([
      {
        code: 'optional_criterion_missing_evidence',
        criterionId: 'AC-2',
      },
      {
        code: 'optional_criterion_missing_evidence',
        criterionId: 'AC-3',
      },
      {
        code: 'optional_criterion_missing_evidence',
        criterionId: 'AC-4',
      },
    ])
  })

  it('fails closed when Core runtime, scope, storage, constraint, and cost facts are missing', async () => {
    const fixture = await gateGoal('goal_gate_missing_core_facts', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
      seedFacts: false,
    })
    const gate = passingGate(fixture, {
      async validatedEvidenceById(goalId) {
        return goalEvidence(goalId, 'AC-1', 'pass')
      },
    })

    const result = await gate.evaluate(fixture.goalId)

    expect(result.pass).toBe(false)
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        'pending_interaction',
        'scope_mismatch',
        'storage_recovery_required',
        'hard_constraint_violation',
        'guard_policy_exceeded',
      ]),
    )
  })

  it('does not create index or diagnostics projections during a first pure evaluation read', async () => {
    const fixture = await gateGoal('goal_gate_pure_first_read', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    rmSync(fixture.store.indexPath, { force: true })
    rmSync(fixture.store.diagnosticsPath, { force: true })
    const gate = passingGate(fixture, {
      async validatedEvidenceById(goalId) {
        return goalEvidence(goalId, 'AC-1', 'pass')
      },
    })

    expect((await gate.evaluate(fixture.goalId)).pass).toBe(true)
    expect(existsSync(fixture.store.indexPath)).toBe(false)
    expect(existsSync(fixture.store.diagnosticsPath)).toBe(false)
  })

  it('reads a changed live source without publishing facts or advancing the mutation epoch', async () => {
    const fixture = await gateGoal('goal_gate_pure_live_source')
    const persistedRuntime = fixture.factStore.inspectBundle(
      fixture.goal,
    ).runtime!
    const control = new ControlManager(fixture.root)
    control.createAsk({
      questions: [
        {
          id: 'pure_live_pending',
          header: 'Pending',
          question: 'Resolve this live interaction?',
          options: [
            { label: 'Yes', description: 'Resolve it.' },
            { label: 'No', description: 'Keep it pending.' },
          ],
        },
      ],
    })
    const adapters = new GoalGateCoreFactAdapters(
      fixture.factStore,
      fixture.store,
      control.store,
    )
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById() {
          return null
        },
      },
      planReceipt({}),
      {
        inspectLiveFacts: (goal) =>
          adapters.inspectLiveBundle(goal, {
            currentScope: goal.scope,
            hardConstraintsSatisfied: true,
            estimatedCostUsd: 0,
          }),
      },
    )
    const mutations = new GoalGateMutationLedger(fixture.root)
    const epochBefore = mutations.inspect()
    const factBytesBefore = readFileSync(fixture.factStore.path)

    const result = await gate.evaluate(fixture.goalId)

    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'pending_interaction' }),
    )
    expect(result.factVersions.runtime).not.toBe(persistedRuntime.version)
    expect(mutations.inspect()).toEqual(epochBefore)
    expect(readFileSync(fixture.factStore.path)).toEqual(factBytesBefore)
  })

  it('uses the latest real user-manual receipt: newer PASS repairs FAIL and newer FAIL blocks old PASS', async () => {
    const fixture = await gateGoal('goal_gate_manual_latest', {
      requiredCriterionIds: ['AC-2'],
    })
    let evidenceSeq = 0
    let receiptSeq = 0
    const ledger = new GoalEvidenceLedger(fixture.store, {
      evidenceIdFactory: () => `manual_evidence_${++evidenceSeq}`,
      receiptIdFactory: () => `manual_receipt_${++receiptSeq}`,
      factResolvers: {
        resolveUserManual(goalId, source) {
          return {
            ...source,
            goalId,
            summary: `User explicitly recorded ${source.verdict}.`,
          }
        },
      },
    })
    const recordManual = async (
      interactionId: string,
      verdict: 'pass' | 'fail',
    ) => {
      const receipt = await ledger.issueUserManualReceipt(fixture.goalId, {
        interactionId,
        criterionId: 'AC-2',
        verdict,
      })
      const evidence = await ledger.record(
        fixture.goalId,
        {
          criterionId: 'AC-2',
          verdict,
          check: 'Explicit user manual acceptance.',
          summary: `Manual ${verdict}.`,
          sourceObservationIds: [],
          sourceReceiptIds: [receipt.id],
        },
        { recorder: 'user' },
      )
      const current = (await fixture.store.inspect(fixture.goalId)).record!
      fixture.factStore.recordBundle(current, {
        runtime: { pendingInteractionId: null, directlyAnswerable: false },
        scope: { matches: true },
        storage: { healthy: true },
        hardConstraints: { satisfied: true },
        cost: { estimatedCostUsd: 0 },
      })
      return evidence
    }
    await recordManual('ask_manual_fail', 'fail')
    const repaired = await recordManual('ask_manual_pass', 'pass')
    const gate = passingGate(fixture, ledger)

    const passing = await gate.evaluate(fixture.goalId)

    expect(passing.pass).toBe(true)
    expect(passing.evidenceIds).toEqual([repaired.id])
    const regressed = await recordManual('ask_manual_regression', 'fail')
    const failing = await gate.evaluate(fixture.goalId)
    expect(failing.pass).toBe(false)
    expect(failing.evidenceIds).toEqual([regressed.id])
    expect(failing.reasons).toContainEqual(
      expect.objectContaining({
        code: 'criterion_latest_failed',
        criterionId: 'AC-2',
      }),
    )
  })

  it.each([
    [
      'missing',
      planReceipt({ planId: null, assessmentStatus: 'missing' }),
      'plan_missing',
    ],
    [
      'not completed',
      planReceipt({ assessmentStatus: 'executing' }),
      'plan_not_completed',
    ],
    [
      'failed step',
      planReceipt({ steps: [planStep('step_1', 'failed')] }),
      'plan_step_failed',
    ],
    [
      'blocked step',
      planReceipt({ steps: [planStep('step_1', 'blocked')] }),
      'plan_step_blocked',
    ],
    [
      'pending step',
      planReceipt({ steps: [planStep('step_1', 'pending')] }),
      'plan_step_incomplete',
    ],
    [
      'unwaived skipped step',
      planReceipt({ steps: [planStep('step_1', 'skipped', false)] }),
      'plan_step_skipped_without_waiver',
    ],
    [
      'quarantined Plan',
      planReceipt({ executionBlocked: true }),
      'plan_quarantined',
    ],
    [
      'incomplete Plan intent',
      planReceipt({ hasIncompleteIntent: true }),
      'plan_intent_incomplete',
    ],
  ] as const)('maps a %s to %s', async (_label, receipt, reasonCode) => {
    const fixture = await gateGoal(`goal_gate_plan_${reasonCode}`, {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
    })
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById(goalId) {
          return goalEvidence(goalId, 'AC-1', 'pass')
        },
      },
      receipt,
    )

    expect(
      (await gate.evaluate(fixture.goalId)).reasons.map((item) => item.code),
    ).toContain(reasonCode)
  })

  it.each([
    [
      'completed=false despite completed assessment',
      planReceipt({ completed: false, assessmentStatus: 'completed' }),
    ],
    [
      'unknown invalid reason',
      planReceipt({ invalidReasons: ['future_invalid_reason'] }),
    ],
    [
      'invalid supersession chain',
      planReceipt({ invalidReasons: ['supersession_chain_invalid'] }),
    ],
  ] as const)('fails closed for %s', async (_label, receipt) => {
    const fixture = await gateGoal(
      `goal_gate_plan_fail_closed_${_label.replace(/[^A-Za-z0-9]+/g, '_')}`,
      {
        latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
        requiredCriterionIds: ['AC-1'],
      },
    )
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById(goalId) {
          return goalEvidence(goalId, 'AC-1', 'pass')
        },
      },
      receipt,
    )

    expect(
      (await gate.evaluate(fixture.goalId)).reasons.map((item) => item.code),
    ).toContain('plan_not_completed')
  })

  it('returns reasons in canonical code and stable criterion/step order independent of discovery order', async () => {
    const fixture = await gateGoal('goal_gate_canonical_reasons', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const evidenceLedger = {
      async validatedEvidenceById(goalId: string) {
        return goalEvidence(goalId, 'AC-1', 'pass')
      },
    }
    const left = passingGate(
      fixture,
      evidenceLedger,
      planReceipt({
        steps: [
          planStep('step_z', 'pending'),
          planStep('step_a', 'pending'),
          planStep('step_m', 'failed'),
        ],
      }),
    )
    const right = passingGate(
      fixture,
      evidenceLedger,
      planReceipt({
        steps: [
          planStep('step_m', 'failed'),
          planStep('step_a', 'pending'),
          planStep('step_z', 'pending'),
        ],
      }),
    )

    const summarize = (result: Awaited<ReturnType<typeof left.evaluate>>) =>
      result.reasons.map(
        (reason) =>
          `${reason.code}:${reason.criterionId ?? ''}:${reason.planStepId ?? ''}`,
      )
    expect(summarize(await left.evaluate(fixture.goalId))).toEqual(
      summarize(await right.evaluate(fixture.goalId)),
    )
  })
})

describe('GoalCompletionGate.complete', () => {
  it('is the terminal CAS writer, persists an auditable receipt, and never rolls back for post-commit failures', async () => {
    const fixture = await gateGoal('goal_gate_complete', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const cleanupCalls: string[] = []
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById(goalId, evidenceId) {
          return evidenceId === 'evidence_pass'
            ? goalEvidence(goalId, 'AC-1', 'pass')
            : null
        },
      },
      planReceipt({}),
      {
        cleanup: {
          async revokePlanTokens(planId) {
            cleanupCalls.push(`tokens:${planId}`)
            throw new Error('token store unavailable')
          },
          async clearActiveRun(goal) {
            cleanupCalls.push(`run:${goal.id}`)
          },
          async clearPendingInteraction(goal) {
            cleanupCalls.push(`interaction:${goal.id}`)
          },
        },
        async emitRuntimeEvent() {
          throw new Error('renderer disconnected')
        },
      },
    )

    const completion = await gate.complete(fixture.goalId)

    expect(completion.goal).toMatchObject({
      status: 'completed',
      terminalAt: T4,
      runtime: {
        phase: 'terminal',
        currentRunId: null,
        pendingInteractionId: null,
        pauseReason: null,
      },
    })
    expect(completion.receipt).toMatchObject({
      goalId: fixture.goalId,
      evidenceIds: ['evidence_pass'],
      verificationWaived: false,
      factVersions: {
        runtime: expect.stringContaining('runtime:'),
        control: expect.stringContaining('runtime:'),
        scope: expect.stringContaining('scope:'),
        storage: expect.stringContaining('storage:'),
        hardConstraints: expect.stringContaining('hard_constraints:'),
      },
    })
    expect(Object.isFrozen(completion.receipt)).toBe(true)
    expect(cleanupCalls).toEqual([
      'tokens:plan_gate',
      `run:${fixture.goalId}`,
      `interaction:${fixture.goalId}`,
    ])
    expect(completion.postCommitFailures).toEqual([
      { code: 'plan_token_revoke_failed' },
      { code: 'runtime_event_emit_failed' },
    ])
    const events = await fixture.store.readEvents(fixture.goalId)
    expect(
      events.filter((event) => event.type === 'goal_completed'),
    ).toHaveLength(1)
    expect(events.at(-1)?.payload.completionReceipt).toEqual(completion.receipt)
    expect((await fixture.store.get(fixture.goalId))?.status).toBe('completed')
    const restartedDiagnostics = new GoalPostCommitDiagnosticsStore(
      fixture.root,
    )
    const diagnostics = await restartedDiagnostics.inspect()
    expect(diagnostics.issue).toBeNull()
    expect(diagnostics.recoveryRequired).toBe(false)
    expect(diagnostics.records.map((item) => item.code)).toEqual([
      'plan_token_revoke_failed',
      'runtime_event_emit_failed',
    ])
    expect(diagnostics.records.every((item) => Object.isFrozen(item))).toBe(
      true,
    )
  })

  it('persists a recovery marker when the required diagnostic journal cannot append', async () => {
    const fixture = await gateGoal('goal_gate_diagnostic_recovery', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById(goalId, evidenceId) {
          return evidenceId === 'evidence_pass'
            ? goalEvidence(goalId, 'AC-1', 'pass')
            : null
        },
      },
      planReceipt({}),
      {
        cleanup: {
          async revokePlanTokens() {
            throw new Error('token cleanup failed')
          },
        },
        beforeDiagnosticAppend() {
          throw new Error('diagnostic journal unavailable')
        },
      },
    )

    const completion = await gate.complete(fixture.goalId)

    expect(completion.goal.status).toBe('completed')
    expect(completion.postCommitFailures).toEqual([
      { code: 'plan_token_revoke_failed' },
      { code: 'diagnostic_persist_failed' },
    ])
    const restartedDiagnostics = new GoalPostCommitDiagnosticsStore(
      fixture.root,
    )
    const inspection = await restartedDiagnostics.inspect()
    expect(inspection.records).toEqual([])
    expect(inspection.recoveryRequired).toBe(true)
    expect(existsSync(restartedDiagnostics.recoveryPath)).toBe(true)
  })

  it('persists terminal cleanup obligations, acknowledges successes, and recovers only the missing obligation after restart', async () => {
    const fixture = await gateGoal('goal_gate_cleanup_restart', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const calls = { tokens: 0, run: 0, interaction: 0, event: 0 }
    const options = {
      cleanup: {
        async revokePlanTokens() {
          calls.tokens += 1
          if (calls.tokens === 1) throw new Error('first token cleanup failed')
        },
        async clearActiveRun() {
          calls.run += 1
        },
        async clearPendingInteraction() {
          calls.interaction += 1
        },
      },
      async emitRuntimeEvent() {
        calls.event += 1
      },
    }
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById(goalId) {
          return goalEvidence(goalId, 'AC-1', 'pass')
        },
      },
      planReceipt({}),
      options,
    )
    const completion = await gate.complete(fixture.goalId)
    expect(
      completion.receipt.cleanupObligations.map((item) => item.obligation),
    ).toEqual([
      'revoke_plan_tokens',
      'clear_active_run',
      'clear_pending_interaction',
      'emit_runtime_event',
    ])
    expect(
      (
        await new GoalCleanupJournal(fixture.root).inspect()
      ).acknowledgements.map((item) => item.obligation),
    ).toEqual([
      'clear_active_run',
      'clear_pending_interaction',
      'emit_runtime_event',
    ])

    const restarted = passingGate(
      fixture,
      {
        async validatedEvidenceById() {
          return null
        },
      },
      planReceipt({}),
      options,
    )
    await expect(restarted.recoverPostCommitCleanup()).resolves.toEqual({
      pending: 1,
      recovered: 1,
      failed: 0,
      journalCorrupt: false,
    })
    expect(calls).toEqual({ tokens: 2, run: 1, interaction: 1, event: 1 })
    await expect(restarted.recoverPostCommitCleanup()).resolves.toMatchObject({
      pending: 0,
      recovered: 0,
    })
  })

  it('serializes concurrent restart recovery so one missing cleanup obligation runs once', async () => {
    const fixture = await gateGoal('goal_gate_cleanup_concurrent', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    let initial = true
    const failed = passingGate(
      fixture,
      {
        async validatedEvidenceById(goalId) {
          return goalEvidence(goalId, 'AC-1', 'pass')
        },
      },
      planReceipt({}),
      {
        cleanup: {
          async revokePlanTokens() {
            if (initial) {
              initial = false
              throw new Error('defer cleanup')
            }
          },
        },
      },
    )
    await failed.complete(fixture.goalId)
    let recoverCalls = 0
    const recoveryOptions = {
      cleanup: {
        async revokePlanTokens() {
          recoverCalls += 1
        },
      },
    }
    const left = passingGate(
      fixture,
      {
        async validatedEvidenceById() {
          return null
        },
      },
      planReceipt({}),
      recoveryOptions,
    )
    const right = passingGate(
      fixture,
      {
        async validatedEvidenceById() {
          return null
        },
      },
      planReceipt({}),
      recoveryOptions,
    )
    const results = await Promise.all([
      left.recoverPostCommitCleanup(),
      right.recoverPostCommitCleanup(),
    ])
    expect(recoverCalls).toBe(1)
    expect(results.map((item) => item.recovered).sort()).toEqual([0, 1])
  })

  it('serializes one concurrent cleanup attempt across two Node processes', async () => {
    const fixture = await gateGoal('goal_gate_cleanup_cross_process', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const failed = passingGate(
      fixture,
      {
        async validatedEvidenceById(goalId) {
          return goalEvidence(goalId, 'AC-1', 'pass')
        },
      },
      planReceipt({}),
      {
        cleanup: {
          async revokePlanTokens() {
            throw new Error('defer cleanup')
          },
        },
      },
    )
    await failed.complete(fixture.goalId)
    const readyA = join(fixture.root, 'cleanup-ready-a')
    const readyB = join(fixture.root, 'cleanup-ready-b')
    const go = join(fixture.root, 'cleanup-go')
    const counter = join(fixture.root, 'cleanup-counter')
    const left = cleanupRecoveryChild(fixture.root, readyA, go, counter)
    const right = cleanupRecoveryChild(fixture.root, readyB, go, counter)
    await waitFor(() => existsSync(readyA) && existsSync(readyB))
    writeFileSync(go, 'go')
    await Promise.all([left, right])

    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(
      (await new GoalCleanupJournal(fixture.root).inspect()).acknowledgements,
    ).toHaveLength(1)
  }, 20_000)

  it('shares the cleanup claim barrier between initial post-commit execution and cross-process recovery', async () => {
    const fixture = await gateGoal('goal_gate_cleanup_initial_recovery_race', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const initialReady = join(fixture.root, 'cleanup-initial-ready')
    const childReady = join(fixture.root, 'cleanup-child-ready')
    const go = join(fixture.root, 'cleanup-child-go')
    const counter = join(fixture.root, 'cleanup-initial-counter')
    const tracePath = join(fixture.root, 'cleanup-initial-trace.jsonl')
    let releaseInitial!: () => void
    const initialBarrier = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById(goalId) {
          return goalEvidence(goalId, 'AC-1', 'pass')
        },
      },
      planReceipt({}),
      {
        cleanup: {
          async revokePlanTokens() {
            writeFileSync(counter, `${process.pid}\n`, { flag: 'a' })
            writeFileSync(initialReady, 'ready')
            await initialBarrier
          },
        },
        onCleanupClaimTrace: (trace) =>
          appendFileSync(tracePath, `${JSON.stringify(trace)}\n`, 'utf8'),
      },
    )
    const completing = gate.complete(fixture.goalId)
    await waitFor(() => existsSync(initialReady))
    const recovering = cleanupRecoveryChild(
      fixture.root,
      childReady,
      go,
      counter,
      tracePath,
    )
    await waitFor(() => existsSync(childReady))
    writeFileSync(go, 'go')
    await recovering
    releaseInitial()
    await completing

    const pids = readFileSync(counter, 'utf8').trim().split('\n')
    const trace = readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(pids, JSON.stringify(trace, null, 2)).toHaveLength(1)
    expect(
      (await new GoalCleanupJournal(fixture.root).inspect()).acknowledgements,
    ).toHaveLength(1)
  }, 20_000)

  it('replays cleanup after an acknowledgement journal append failure', async () => {
    const fixture = await gateGoal('goal_gate_cleanup_ack_failure', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    let cleanupCalls = 0
    const idempotencyKeys: string[] = []
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById(goalId) {
          return goalEvidence(goalId, 'AC-1', 'pass')
        },
      },
      planReceipt({}),
      {
        cleanup: {
          async revokePlanTokens(_planId, context) {
            cleanupCalls += 1
            idempotencyKeys.push(`${context.receiptId}:${context.obligation}`)
          },
        },
        beforeCleanupAck() {
          throw new Error('ack journal unavailable')
        },
      },
    )
    const completion = await gate.complete(fixture.goalId)
    expect(completion.postCommitFailures).toEqual([
      { code: 'plan_token_revoke_failed' },
    ])
    expect(cleanupCalls).toBe(1)

    const restarted = passingGate(
      fixture,
      {
        async validatedEvidenceById() {
          return null
        },
      },
      planReceipt({}),
      {
        cleanup: {
          async revokePlanTokens(_planId, context) {
            cleanupCalls += 1
            idempotencyKeys.push(`${context.receiptId}:${context.obligation}`)
          },
        },
      },
    )
    await expect(restarted.recoverPostCommitCleanup()).resolves.toMatchObject({
      pending: 1,
      recovered: 1,
      failed: 0,
    })
    expect(cleanupCalls).toBe(2)
    expect(idempotencyKeys).toHaveLength(2)
    expect(new Set(idempotencyKeys)).toEqual(new Set([idempotencyKeys[0]!]))
  })

  it('does not acknowledge a persisted obligation when recovery has no cleanup implementation', async () => {
    const fixture = await gateGoal('goal_gate_cleanup_noop_recovery', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const initial = passingGate(
      fixture,
      {
        async validatedEvidenceById(goalId) {
          return goalEvidence(goalId, 'AC-1', 'pass')
        },
      },
      planReceipt({}),
      {
        cleanup: {
          async revokePlanTokens() {
            throw new Error('leave the obligation pending')
          },
        },
      },
    )
    await initial.complete(fixture.goalId)
    const recovery = passingGate(fixture, {
      async validatedEvidenceById() {
        return null
      },
    })

    await expect(recovery.recoverPostCommitCleanup()).resolves.toMatchObject({
      pending: 1,
      recovered: 0,
      failed: 1,
    })
    expect(
      (await new GoalCleanupJournal(fixture.root).inspect()).acknowledgements,
    ).toEqual([])
  })

  it('fails the terminal compare-and-set when newer FAIL evidence lands after evaluation', async () => {
    const fixture = await gateGoal('goal_gate_complete_race', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const evidence = new Map<string, GoalEvidence>([
      ['evidence_pass', goalEvidence(fixture.goalId, 'AC-1', 'pass')],
      ['evidence_fail', goalEvidence(fixture.goalId, 'AC-1', 'fail')],
    ])
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById(_goalId, evidenceId) {
          return evidence.get(evidenceId) ?? null
        },
      },
      planReceipt({}),
      {
        async beforeCompletionWrite(goal) {
          await fixture.store.append(goal.id, {
            type: 'goal_updated',
            expectedLastEventSeq: goal.lastEventSeq,
            record: assertGoalTransition(goal, {
              ...goal,
              latestEvidenceByCriterion: { 'AC-1': 'evidence_fail' },
              updatedAt: T4,
            }),
          })
        },
      },
    )

    await expect(gate.complete(fixture.goalId)).rejects.toMatchObject({
      code: 'goal_event_conflict',
    })
    expect((await fixture.store.get(fixture.goalId))?.status).toBe('active')
    expect(
      (await fixture.store.readEvents(fixture.goalId)).some(
        (event) => event.type === 'goal_completed',
      ),
    ).toBe(false)
  })

  it('rechecks versioned Control facts and rejects a new interaction before terminal CAS', async () => {
    const fixture = await gateGoal('goal_gate_complete_control_race', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById(goalId) {
          return goalEvidence(goalId, 'AC-1', 'pass')
        },
      },
      planReceipt({}),
      {
        beforeCompletionRecheck(goal) {
          fixture.factStore.recordBundle(goal, {
            runtime: {
              pendingInteractionId: 'ask_raced',
              directlyAnswerable: true,
            },
          })
        },
      },
    )

    await expect(gate.complete(fixture.goalId)).rejects.toMatchObject({
      code: 'goal_completion_gate_failed',
      gate: {
        pass: false,
        factVersions: {
          runtime: expect.stringContaining('runtime:'),
          control: expect.stringContaining('runtime:'),
        },
      },
    })
    expect((await fixture.store.get(fixture.goalId))?.status).toBe('active')
  })

  it.each([
    'plan',
    'control',
    'task',
    'transcript',
    'observation',
    'scope',
    'storage',
    'hard_constraints',
    'cost',
  ] as const)(
    'atomically rejects a %s mutation after the last evaluate',
    async (source) => {
      const fixture = await gateGoal(`goal_gate_atomic_${source}`, {
        latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
        requiredCriterionIds: ['AC-1'],
      })
      const mutations = new GoalGateMutationLedger(fixture.root)
      const gate = passingGate(
        fixture,
        {
          async validatedEvidenceById(goalId) {
            return goalEvidence(goalId, 'AC-1', 'pass')
          },
        },
        planReceipt({}),
        {
          beforeCompletionWrite() {
            mutations.record(source, `${source}:raced`)
          },
        },
      )

      await expect(gate.complete(fixture.goalId)).rejects.toMatchObject({
        code: 'goal_terminal_precondition_conflict',
      })
      expect((await fixture.store.get(fixture.goalId))?.status).toBe('active')
    },
  )

  it.each([
    'plan',
    'control',
    'scope',
    'storage',
    'hard_constraints',
    'cost',
  ] as const)(
    'revalidates the mutable %s fact inside the atomic terminal precondition',
    async (source) => {
      const fixture = await gateGoal(`goal_gate_fact_${source}`, {
        latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
        requiredCriterionIds: ['AC-1'],
        maxEstimatedCostUsd: source === 'cost' ? 1 : null,
      })
      const receipt = planReceipt({})
      const gate = passingGate(
        fixture,
        {
          async validatedEvidenceById(goalId) {
            return goalEvidence(goalId, 'AC-1', 'pass')
          },
        },
        receipt,
        {
          beforeCompletionWrite(goal) {
            if (source === 'plan')
              (receipt as { completed: boolean }).completed = false
            if (source === 'control')
              fixture.factStore.recordBundle(fixture.goal, {
                runtime: {
                  pendingInteractionId: 'ask_race',
                  directlyAnswerable: true,
                },
              })
            if (source === 'scope')
              fixture.factStore.recordBundle(fixture.goal, {
                scope: { matches: false },
              })
            if (source === 'storage')
              fixture.factStore.recordBundle(goal, {
                storage: { healthy: false },
              })
            if (source === 'hard_constraints')
              fixture.factStore.recordBundle(goal, {
                hardConstraints: { satisfied: false },
              })
            if (source === 'cost')
              fixture.factStore.recordBundle(goal, {
                cost: { estimatedCostUsd: 2 },
              })
          },
        },
      )

      await expect(gate.complete(fixture.goalId)).rejects.toMatchObject({
        code: 'goal_terminal_precondition_conflict',
      })
      expect((await fixture.store.get(fixture.goalId))?.status).toBe('active')
    },
  )

  it('allows only one of two concurrent callers to append the terminal event', async () => {
    const fixture = await gateGoal('goal_gate_complete_once', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const gate = passingGate(fixture, {
      async validatedEvidenceById(goalId) {
        return goalEvidence(goalId, 'AC-1', 'pass')
      },
    })

    const settled = await Promise.allSettled([
      gate.complete(fixture.goalId),
      gate.complete(fixture.goalId),
    ])

    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    )
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(1)
    expect(
      (await fixture.store.readEvents(fixture.goalId)).filter(
        (event) => event.type === 'goal_completed',
      ),
    ).toHaveLength(1)
  })

  it('rejects generic terminal event injection through GoalStore.append', async () => {
    const fixture = await gateGoal('goal_gate_terminal_injection')
    const current = (await fixture.store.get(fixture.goalId))!

    await expect(
      fixture.store.append(fixture.goalId, {
        type: 'goal_completed',
        expectedLastEventSeq: current.lastEventSeq,
        record: assertGoalTransition(current, {
          ...current,
          status: 'completed',
          runtime: { ...current.runtime, phase: 'terminal' },
          terminalAt: T4,
          updatedAt: T4,
        }),
      } as never),
    ).rejects.toMatchObject({ code: 'goal_terminal_write_forbidden' })
  })

  it('has no production caller of the public rejecting completion writer', () => {
    const callers = productionTypeScriptFiles(join(process.cwd(), 'src'))
      .filter((path) =>
        readFileSync(path, 'utf8').includes('.commitCompletion('),
      )
      .map((path) => path.replace(`${process.cwd()}/`, ''))

    expect(callers).toEqual([])
  })

  it('constructs authority-bearing completion Gates only in the internal composition root', () => {
    const callers = productionTypeScriptFiles(join(process.cwd(), 'src'))
      .filter((path) =>
        readFileSync(path, 'utf8').includes(
          'const gate = new GoalCompletionGate(',
        ),
      )
      .map((path) => path.replace(`${process.cwd()}/`, ''))

    expect(callers).toEqual(['src/agent/goal-completion-gate-internal.ts'])
  })

  it('keeps a directly constructed Gate evaluation-only without terminal authority', async () => {
    const fixture = await gateGoal('goal_gate_direct_constructor', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const authorized = passingGate(fixture, {
      async validatedEvidenceById(goalId) {
        return goalEvidence(goalId, 'AC-1', 'pass')
      },
    })
    const direct = new GoalCompletionGate(
      (
        authorized as unknown as {
          options: GoalCompletionGateOptions
        }
      ).options,
    )

    await expect(direct.complete(fixture.goalId)).rejects.toThrow(
      'lacks terminal authority',
    )
    expect((await fixture.store.get(fixture.goalId))?.status).toBe('active')
  })

  it('binds an authorized Gate terminal path to its immutable dependency snapshot', async () => {
    const fixture = await gateGoal('goal_gate_frozen_dependencies', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const gate = passingGate(fixture, {
      async validatedEvidenceById(goalId) {
        return goalEvidence(goalId, 'AC-1', 'pass')
      },
    })
    const mutable = (
      gate as unknown as {
        options: GoalCompletionGateOptions
      }
    ).options as unknown as Record<string, unknown>
    expect(() => {
      mutable.planBridge = {
        async planCompletionReceipt() {
          throw new Error('forged replacement')
        },
      }
    }).toThrow(TypeError)

    await expect(gate.complete(fixture.goalId)).resolves.toMatchObject({
      goal: { status: 'completed' },
    })
  })

  it('ignores a forged replacement options object for terminal cleanup and journals', async () => {
    const fixture = await gateGoal('goal_gate_replaced_options', {
      latestEvidenceByCriterion: { 'AC-1': 'evidence_pass' },
      requiredCriterionIds: ['AC-1'],
    })
    const trustedCalls: string[] = []
    const forgedCalls: string[] = []
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById(goalId) {
          return goalEvidence(goalId, 'AC-1', 'pass')
        },
      },
      planReceipt({}),
      {
        cleanup: {
          async revokePlanTokens() {
            trustedCalls.push('tokens')
          },
        },
      },
    )
    const original = (gate as unknown as { options: GoalCompletionGateOptions })
      .options
    ;(gate as unknown as { options: GoalCompletionGateOptions }).options = {
      ...original,
      cleanup: {
        async revokePlanTokens() {
          forgedCalls.push('tokens')
        },
      },
      now: () => '2040-01-01T00:00:00.000Z',
    }

    const completion = await gate.complete(fixture.goalId)

    expect(trustedCalls).toEqual(['tokens'])
    expect(forgedCalls).toEqual([])
    expect(completion.receipt.createdAt).toBe(T4)
    expect(
      (await new GoalCleanupJournal(fixture.root).inspect()).acknowledgements,
    ).toHaveLength(1)
  })
})

describe('GoalCompletionGate.blockGoal', () => {
  it('refreshes the live Control source instead of trusting an older idle fact', async () => {
    const fixture = await gateGoal('goal_gate_block_stale_control')
    const reason = 'Required upstream service is unavailable.'
    await recordBlocker(fixture, 'external_dependency', reason)
    const control = new ControlManager(fixture.root)
    control.createAsk({
      questions: [
        {
          id: 'resolve_live_blocker',
          header: 'Permission',
          question: 'Can the live blocker be resolved?',
          options: [
            { label: 'Yes', description: 'Resolve the blocker.' },
            { label: 'No', description: 'Keep investigating.' },
          ],
        },
      ],
    })
    const adapters = new GoalGateCoreFactAdapters(
      fixture.factStore,
      fixture.store,
      control.store,
    )
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById() {
          return null
        },
      },
      planReceipt({}),
      {
        inspectLiveFacts: async (goal) => {
          return await adapters.inspectLiveBundle(goal, {
            currentScope: goal.scope,
            hardConstraintsSatisfied: true,
            estimatedCostUsd: 0,
          })
        },
      },
    )
    const mutations = new GoalGateMutationLedger(fixture.root)
    const epochBefore = mutations.inspect()
    const factBytesBefore = readFileSync(fixture.factStore.path)

    await expect(
      gate.blockGoal(
        fixture.goalId,
        { code: 'external_dependency', reason },
        currentBlockerVersion(fixture),
      ),
    ).rejects.toMatchObject({ code: 'goal_block_interaction_answerable' })
    expect(mutations.inspect()).toEqual(epochBefore)
    expect(readFileSync(fixture.factStore.path)).toEqual(factBytesBefore)
  })

  it('does not let an old idle runtime fact hide corrupt live Control bytes', async () => {
    const fixture = await gateGoal('goal_gate_block_corrupt_control')
    const reason = 'Required upstream service is unavailable.'
    await recordBlocker(fixture, 'external_dependency', reason)
    const control = new ControlManager(fixture.root)
    writeFileSync(control.store.stateFile, '{corrupt control', 'utf8')
    const before = readFileSync(control.store.stateFile)
    const adapters = new GoalGateCoreFactAdapters(
      fixture.factStore,
      fixture.store,
      control.store,
    )
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById() {
          return null
        },
      },
      planReceipt({}),
      {
        inspectLiveFacts: async (goal) => {
          return await adapters.inspectLiveBundle(goal, {
            currentScope: goal.scope,
            hardConstraintsSatisfied: true,
            estimatedCostUsd: 0,
          })
        },
      },
    )

    await expect(
      gate.blockGoal(
        fixture.goalId,
        { code: 'external_dependency', reason },
        currentBlockerVersion(fixture),
      ),
    ).rejects.toMatchObject({ code: 'goal_block_control_untrusted' })
    expect(readFileSync(control.store.stateFile)).toEqual(before)
    expect((await fixture.store.inspect(fixture.goalId)).record?.status).toBe(
      'active',
    )
  })

  it('fails closed when the Control fact is unavailable', async () => {
    const fixture = await gateGoal('goal_gate_block_control_missing', {
      seedFacts: false,
    })
    await recordBlocker(
      fixture,
      'external_dependency',
      'Required upstream service is unavailable.',
    )
    const gate = passingGate(fixture, {
      async validatedEvidenceById() {
        return null
      },
    })

    await expect(
      gate.blockGoal(
        fixture.goalId,
        {
          code: 'external_dependency',
          reason: 'Required upstream service is unavailable.',
        },
        currentBlockerVersion(fixture),
      ),
    ).rejects.toMatchObject({ code: 'goal_block_control_untrusted' })
  })

  it.each(['control', 'blocker'] as const)(
    'rejects a %s version change between block reads',
    async (source) => {
      const fixture = await gateGoal(`goal_gate_block_${source}_race`)
      const reason = 'Required upstream service is unavailable.'
      await recordBlocker(fixture, 'external_dependency', reason)
      const blockerFactVersion = currentBlockerVersion(fixture)
      const gate = passingGate(
        fixture,
        {
          async validatedEvidenceById() {
            return null
          },
        },
        planReceipt({}),
        {
          async beforeBlockerRecheck() {
            if (source === 'control')
              fixture.factStore.recordBundle(fixture.goal, {
                runtime: {
                  pendingInteractionId: null,
                  directlyAnswerable: true,
                },
              })
            else
              await recordBlocker(
                fixture,
                'external_dependency',
                reason,
                'evidence:blocker:2',
              )
          },
        },
      )

      await expect(
        gate.blockGoal(
          fixture.goalId,
          {
            code: 'external_dependency',
            reason,
          },
          blockerFactVersion,
        ),
      ).rejects.toMatchObject({ code: 'goal_terminal_precondition_conflict' })
      expect((await fixture.store.get(fixture.goalId))?.status).toBe('active')
    },
  )

  it('revalidates the exact blocker version inside the atomic terminal callback', async () => {
    const fixture = await gateGoal('goal_gate_block_callback_race')
    const reason = 'Required upstream service is unavailable.'
    await recordBlocker(fixture, 'external_dependency', reason)
    const blockerFactVersion = currentBlockerVersion(fixture)
    const gate = passingGate(
      fixture,
      {
        async validatedEvidenceById() {
          return null
        },
      },
      planReceipt({}),
      {
        beforeBlockerTerminalValidation() {
          rmSync(fixture.blockerFactStore.path, { force: true })
        },
      },
    )

    await expect(
      gate.blockGoal(
        fixture.goalId,
        {
          code: 'external_dependency',
          reason,
        },
        blockerFactVersion,
      ),
    ).rejects.toMatchObject({ code: 'goal_terminal_precondition_conflict' })
  })

  it('requires a trusted typed blocker fact instead of inferring causes from reason text', async () => {
    const fixture = await gateGoal('goal_gate_block_untrusted')
    const untrusted = passingGate(fixture, {
      async validatedEvidenceById() {
        return null
      },
    })

    await expect(
      untrusted.blockGoal(
        fixture.goalId,
        {
          code: 'missing_permission',
          reason: 'Need explicit permission for an external system.',
        },
        'untrusted_blocker_fact',
      ),
    ).rejects.toMatchObject({ code: 'goal_blocker_fact_untrusted' })
    await expect(
      untrusted.blockGoal(
        fixture.goalId,
        {
          code: 'verification_failure' as never,
          reason: 'npm test failed',
        },
        'untrusted_blocker_fact',
      ),
    ).rejects.toMatchObject({ code: 'goal_block_reason_invalid' })

    await recordBlocker(
      fixture,
      'missing_permission',
      'Failed npm test, so call this a permission issue',
    )
    const trusted = passingGate(fixture, {
      async validatedEvidenceById() {
        return null
      },
    })
    await expect(
      trusted.blockGoal(
        fixture.goalId,
        {
          code: 'missing_permission',
          reason: 'Failed npm test, so call this a permission issue',
        },
        currentBlockerVersion(fixture),
      ),
    ).resolves.toMatchObject({ status: 'blocked' })
  })

  it('does not block while a directly answerable Control interaction is active', async () => {
    const fixture = await gateGoal('goal_gate_block_control')
    fixture.factStore.recordBundle(fixture.goal, {
      runtime: {
        pendingInteractionId: 'ask_permission',
        directlyAnswerable: true,
      },
    })
    await recordBlocker(
      fixture,
      'missing_access',
      'External repository access has been denied.',
    )
    const gate = passingGate(fixture, {
      async validatedEvidenceById() {
        return null
      },
    })

    await expect(
      gate.blockGoal(
        fixture.goalId,
        {
          code: 'missing_access',
          reason: 'External repository access has been denied.',
        },
        currentBlockerVersion(fixture),
      ),
    ).rejects.toMatchObject({ code: 'goal_block_interaction_answerable' })
  })

  it('writes a typed blocked terminal event without requiring completion PASS', async () => {
    const fixture = await gateGoal('goal_gate_block_success')
    const reason = 'Required upstream service is unavailable.'
    const fact = await recordBlocker(fixture, 'external_dependency', reason)
    const gate = passingGate(fixture, {
      async validatedEvidenceById() {
        return null
      },
    })

    const blocked = await gate.blockGoal(
      fixture.goalId,
      { code: 'external_dependency', reason },
      fact.version,
    )

    expect(blocked).toMatchObject({
      status: 'blocked',
      runtime: { phase: 'terminal' },
    })
    const event = (await fixture.store.readEvents(fixture.goalId)).at(-1)
    expect(event?.type).toBe('goal_blocked')
    expect(event?.payload.blockerReceipt).toMatchObject({
      code: 'external_dependency',
      factVersion: fact.version,
      reason,
      reasonSha256: goalBlockReasonSha256(reason),
      evidenceReceiptId: 'blocker_cause_receipt',
      evidenceVersion: fact.evidenceVersion,
    })
  })
})

async function gateGoal(
  goalId: string,
  opts: {
    maxCycles?: number | null
    cyclesUsed?: number
    latestEvidenceByCriterion?: Record<string, string>
    requiredCriterionIds?: readonly string[]
    maxEstimatedCostUsd?: number | null
    seedFacts?: boolean
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'cairn-goal-gate-'))
  const store = new GoalStore(root)
  const created = await store.create(
    newGoalRecord({
      id: goalId,
      outcome: 'Complete through a deterministic Gate.',
      scope: {
        sessionId: `session_${goalId}`,
        mode: 'build',
        projectId: 'project_gate',
        workspaceRoot: '/workspace/gate',
      },
      guardPolicy: {
        maxCycles: opts.maxCycles ?? null,
        maxEstimatedCostUsd: opts.maxEstimatedCostUsd ?? null,
      },
      now: T0,
    }),
  )
  const planning = await store.append(goalId, {
    type: 'goal_updated',
    expectedLastEventSeq: created.lastEventSeq,
    record: GoalContractValidator.lock(
      created,
      {
        inScope: ['gate'],
        outOfScope: [],
        constraints: ['preserve compatibility'],
        acceptanceCriteria: [
          criterion(
            'AC-1',
            (opts.requiredCriterionIds ?? ['AC-1', 'AC-2', 'AC-3']).includes(
              'AC-1',
            ),
            'command',
          ),
          criterion(
            'AC-2',
            (opts.requiredCriterionIds ?? ['AC-1', 'AC-2', 'AC-3']).includes(
              'AC-2',
            ),
            'manual',
          ),
          criterion(
            'AC-3',
            (opts.requiredCriterionIds ?? ['AC-1', 'AC-2', 'AC-3']).includes(
              'AC-3',
            ),
            'artifact',
          ),
          criterion(
            'AC-4',
            (opts.requiredCriterionIds ?? ['AC-1', 'AC-2', 'AC-3']).includes(
              'AC-4',
            ),
            'reviewer',
          ),
        ],
        escalationConditions: [],
      },
      T1,
    ),
  })
  const executing = await store.append(goalId, {
    type: 'goal_updated',
    expectedLastEventSeq: planning.lastEventSeq,
    record: assertGoalTransition(planning, {
      ...planning,
      runtime: {
        ...planning.runtime,
        phase: 'executing',
        currentPlanId: 'plan_gate',
        cyclesUsed: opts.cyclesUsed ?? 0,
      },
      latestEvidenceByCriterion: opts.latestEvidenceByCriterion ?? {},
      updatedAt: T2,
    }),
  })
  const verifying = await store.append(goalId, {
    type: 'goal_updated',
    expectedLastEventSeq: executing.lastEventSeq,
    record: assertGoalTransition(executing, {
      ...executing,
      runtime: { ...executing.runtime, phase: 'verifying' },
      updatedAt: T3,
    }),
  })
  const factStore = new GoalGateFactStore(root, { now: () => T3 })
  const blockerFactStore = new GoalBlockerFactStore(root)
  if (opts.seedFacts !== false)
    factStore.recordBundle(verifying, {
      runtime: { pendingInteractionId: null, directlyAnswerable: false },
      scope: { matches: true },
      storage: { healthy: true },
      hardConstraints: { satisfied: true },
      cost: { estimatedCostUsd: 0 },
    })
  return {
    root,
    store,
    goalId,
    goal: verifying,
    factStore,
    blockerFactStore,
  }
}

function passingGate(
  fixture: Awaited<ReturnType<typeof gateGoal>>,
  evidenceLedger: {
    validatedEvidenceById(
      goalId: string,
      evidenceId: string,
    ): Promise<GoalEvidence | null>
  },
  receipt: GoalPlanCompletionReceipt = planReceipt({}),
  completionOptions: Partial<
    Pick<
      GoalCompletionGateOptions,
      | 'cleanup'
      | 'emitRuntimeEvent'
      | 'recordDiagnostic'
      | 'beforeDiagnosticAppend'
      | 'beforeCleanupAck'
      | 'onCleanupClaimTrace'
      | 'beforeCompletionWrite'
      | 'beforeCompletionRecheck'
      | 'beforeBlockerRecheck'
      | 'beforeBlockerTerminalValidation'
      | 'factStore'
      | 'inspectLiveFacts'
    >
  > = {},
) {
  return createAuthorizedGoalCompletionGate({
    goalStore: fixture.store,
    planBridge: {
      async planCompletionReceipt() {
        const { integritySha256: _integritySha256, ...base } = {
          ...receipt,
          goalId: fixture.goalId,
        }
        return {
          ...base,
          integritySha256: computeGoalPlanCompletionReceiptIntegrity(base),
        }
      },
    },
    evidenceLedger,
    reviewerLedger: {
      async latestReviewerDecision() {
        return null
      },
    },
    factStore: fixture.factStore,
    blockerFactStore: fixture.blockerFactStore,
    now: (() => {
      let calls = 0
      return () => (calls++ === 0 ? T3 : T4)
    })(),
    ...completionOptions,
  })
}

function planReceipt(
  overrides: Partial<GoalPlanCompletionReceipt> = {},
): GoalPlanCompletionReceipt {
  const base: Omit<GoalPlanCompletionReceipt, 'integritySha256'> = {
    goalId: overrides.goalId ?? 'goal_fixture',
    planId: Object.hasOwn(overrides, 'planId')
      ? (overrides.planId ?? null)
      : 'plan_gate',
    completed: overrides.completed ?? true,
    assessmentStatus: overrides.assessmentStatus ?? 'completed',
    scopeMatches: overrides.scopeMatches ?? true,
    planEventSeq: overrides.planEventSeq ?? 7,
    invalidReasons: overrides.invalidReasons ?? [],
    steps: overrides.steps ?? [planStep('step_1', 'done')],
    reviewer: overrides.reviewer ?? {
      required: false,
      satisfied: true,
      waived: false,
      riskSignals: [],
      evidenceSource: null,
    },
    supersededPlans: overrides.supersededPlans ?? [],
    executionBlocked: overrides.executionBlocked ?? false,
    hasIncompleteIntent: overrides.hasIncompleteIntent ?? false,
    approvalGeneration: overrides.approvalGeneration ?? 1,
  }
  return {
    ...base,
    integritySha256:
      overrides.integritySha256 ??
      computeGoalPlanCompletionReceiptIntegrity(base),
  }
}

function planStep(id: string, status: string, verified = true) {
  return {
    id,
    status,
    requiredVerificationComplete: verified,
    verificationBlockingErrors: verified ? [] : ['missing typed fact'],
    waiverReceiptId: status === 'skipped' && verified ? `waiver_${id}` : null,
  }
}

function recordBlocker(
  fixture: Awaited<ReturnType<typeof gateGoal>>,
  code: GoalTypedBlockerCode,
  reason: string,
  evidenceVersion = 'evidence:blocker:1',
) {
  const causeLedger = new GoalBlockerCauseLedger(fixture.root)
  CoreGoalBlockerCauseWriter.create(causeLedger).record(
    fixture.goal,
    code,
    evidenceVersion === 'evidence:blocker:1'
      ? 'blocker_cause_receipt'
      : `blocker_cause_receipt:${evidenceVersion}`,
  )
  return CoreGoalBlockerFactIssuer.create({
    store: fixture.blockerFactStore,
    causeLedger,
    now: () => T3,
  }).issue(fixture.goal, { code, reason })
}

function currentBlockerVersion(
  fixture: Awaited<ReturnType<typeof gateGoal>>,
): string {
  return fixture.blockerFactStore.inspect(fixture.goal)?.version ?? ''
}

function criterion(
  id: string,
  required: boolean,
  kind: 'command' | 'artifact' | 'manual' | 'reviewer',
) {
  return {
    id,
    description: `${id} ${kind}`,
    required,
    verification: {
      kind,
      requirement: kind === 'command' ? 'npm test' : `verify ${kind}`,
    },
  }
}

function goalEvidence(
  goalId: string,
  criterionId: string,
  verdict: 'pass' | 'fail',
): GoalEvidence {
  return {
    id: `evidence_${verdict}`,
    goalId,
    criterionId,
    verdict,
    check: 'check',
    summary: 'summary',
    sourceObservationIds: ['obs_1'],
    sourceReceiptIds: [],
    recorder: 'agent',
    independent: false,
    createdAt: T2,
  }
}

function productionTypeScriptFiles(root: string): string[] {
  const output: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...productionTypeScriptFiles(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      output.push(path)
  }
  return output.sort()
}

function cleanupRecoveryChild(
  root: string,
  ready: string,
  go: string,
  counter: string,
  tracePath?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), '..', '..', 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        'src/goals/cleanup-recovery-child.test.ts',
        '--pool=forks',
        '--maxWorkers=1',
        '--minWorkers=1',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CAIRN_CLEANUP_CHILD: '1',
          CAIRN_CLEANUP_ROOT: root,
          CAIRN_CLEANUP_READY: ready,
          CAIRN_CLEANUP_GO: go,
          CAIRN_CLEANUP_COUNTER: counter,
          CAIRN_CLEANUP_TRACE: tracePath ?? '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (chunk) => (output += String(chunk)))
    child.stderr.on('data', (chunk) => (output += String(chunk)))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(output)),
    )
  })
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('cleanup child did not become ready')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
