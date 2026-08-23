import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ControlManager } from '../control/manager'
import {
  GOAL_REVIEWER_WAIVER_APPROVE_LABEL,
  GOAL_REVIEWER_WAIVER_QUESTION_ID,
} from '../control/plan-verification'
import { PlanStatus, PlanStepStatus, makePlanRecord } from '../plans/models'
import { PlanStore } from '../plans/store'
import { TaskManager } from '../tasks/manager'
import { TaskKind, TaskRecord } from '../tasks/models'
import { ToolResultObj } from '../tools/base'
import { canonicalJson } from './events'
import { GoalEvidenceLedger, GoalObservationRecorder } from './evidence'
import {
  GoalReviewerError,
  GoalReviewerCoreRiskAdapter,
  GoalReviewerLedger,
  GoalReviewerPolicy,
  type GoalReviewerReceipt,
  canonicalRiskSignals,
} from './reviewer'
import { GoalStore } from './store'
import {
  GoalContractValidator,
  assertGoalTransition,
  newGoalRecord,
} from './validation'

const T0 = '2026-07-16T01:00:00.000Z'
const T1 = '2026-07-16T01:01:00.000Z'
const T2 = '2026-07-16T01:02:00.000Z'
const T3 = '2026-07-16T01:03:00.000Z'
const T4 = '2026-07-16T01:04:00.000Z'
const T5 = '2026-07-16T01:05:00.000Z'

describe('GoalReviewerPolicy', () => {
  it('normalizes, deduplicates, and sorts risk signals by rank then lexical order', () => {
    expect(
      canonicalRiskSignals([
        ' API ',
        'security',
        'api',
        'core_capability:Zeta',
        'changed_files>=3',
        'deployment',
        'Permission',
        'zeta',
        '  ',
      ]),
    ).toEqual([
      'permission',
      'security',
      'deployment',
      'changed_files>=3',
      'core_capability:zeta',
      'api',
      'zeta',
    ])
  })

  it('requires independent review from Core-owned Plan risk signals', () => {
    const requirement = new GoalReviewerPolicy().requirementFor(
      makePlanRecord({
        id: 'plan_risky',
        title: 'Change backend permission API',
        summary: 'Release a long-running scheduler migration.',
        status: PlanStatus.COMPLETED,
        createdAt: 1,
        updatedAt: 2,
        steps: [
          step('step_1', [
            'packages/core/src/api/a.ts',
            'packages/core/src/permissions/b.ts',
            'packages/core/src/scheduler/c.ts',
          ]),
        ],
      }),
    )

    expect(requirement.required).toBe(true)
    expect(requirement.riskSignals).toEqual(
      expect.arrayContaining([
        'changed_files>=3',
        'api',
        'permission',
        'scheduler',
        'long_running',
        'data_migration',
        'deployment',
      ]),
    )
  })

  it('requires review when Core cannot prove a low-risk Plan is read-only', () => {
    const requirement = new GoalReviewerPolicy().requirementFor(
      makePlanRecord({
        id: 'plan_readonly',
        title: 'Inspect one file',
        summary: 'Read documentation without changing files.',
        status: PlanStatus.COMPLETED,
        createdAt: 1,
        updatedAt: 2,
        steps: [step('step_1', [])],
      }),
    )

    expect(requirement).toEqual({
      required: true,
      riskSignals: ['readonly_unproven'],
    })
  })

  it('exempts only a Core-proven read-only Plan', () => {
    const plan = makePlanRecord({
      id: 'plan_readonly_proven',
      title: 'Inspect one file',
      summary: 'Read documentation without changing files.',
      status: PlanStatus.COMPLETED,
      createdAt: 1,
      updatedAt: 2,
      steps: [step('step_1', [])],
    })

    expect(
      new GoalReviewerPolicy().requirementFor(plan, {
        kind: 'core_goal_reviewer_risk',
        issuedBy: 'core',
        version: 'risk:1',
        goalId: '',
        planId: plan.id,
        planEventSeq: plan.eventSeq,
        readonlyProven: true,
        changedFiles: [],
        capabilitySignals: [],
      }),
    ).toEqual({ required: false, riskSignals: [] })
  })

  it('does not let a low-risk Plan declaration lower Core-observed mutations', () => {
    const plan = makePlanRecord({
      id: 'plan_core_mutation',
      title: 'Inspect one file',
      summary: 'Read documentation without changing files.',
      status: PlanStatus.COMPLETED,
      createdAt: 1,
      updatedAt: 2,
      steps: [step('step_1', [])],
    })

    const requirement = new GoalReviewerPolicy().requirementFor(plan, {
      kind: 'core_goal_reviewer_risk',
      issuedBy: 'core',
      version: 'risk:2',
      goalId: '',
      planId: plan.id,
      planEventSeq: plan.eventSeq,
      readonlyProven: false,
      changedFiles: ['packages/core/src/api/hidden.ts'],
      capabilitySignals: ['external_write'],
    })

    expect(requirement.required).toBe(true)
    expect(requirement.riskSignals).toEqual(
      expect.arrayContaining([
        'api',
        'core_changed_files>=1',
        'core_capability:external_write',
      ]),
    )
  })

  it('proves low-risk read-only execution from Core observations and detects an undeclared write', async () => {
    const readonlyFixture = await reviewerRiskFixture('goal_risk_readonly')
    const readonlyAdapter = new GoalReviewerCoreRiskAdapter(
      readonlyFixture.planStore,
      readonlyFixture.goalStore,
      readonlyFixture.taskManager.store,
    )
    const readonlyFact = await readonlyAdapter.resolve({
      goalId: readonlyFixture.goal.id,
      planId: readonlyFixture.plan.id,
      planEventSeq: readonlyFixture.plan.eventSeq,
    })
    expect(readonlyFact).toMatchObject({
      readonlyProven: true,
      changedFiles: [],
      capabilitySignals: [],
    })
    expect(
      new GoalReviewerPolicy().requirementFor(
        readonlyFixture.plan,
        readonlyFact,
      ),
    ).toEqual({ required: false, riskSignals: [] })

    const reviewerFixture = await reviewerRiskFixture(
      'goal_risk_reviewer_command',
    )
    const reviewerAgentId = 'reviewer_agent_risk_command'
    const reviewerTask = reviewerFixture.taskManager.startGoalReviewerTask({
      kind: TaskKind.SUBAGENT,
      title: 'Independent Goal reviewer',
      sessionId: reviewerFixture.goal.scope.sessionId,
      turnId: 'reviewer_turn_risk_command',
      metadata: {
        schema_version: 'cairn.goal.reviewer-dispatch.v1',
        issued_by: 'core',
        agent_type: 'verification_reviewer',
        agent_id: reviewerAgentId,
        turn_id: 'reviewer_turn_risk_command',
        goal_id: reviewerFixture.goal.id,
        plan_id: reviewerFixture.plan.id,
        plan_event_seq: reviewerFixture.plan.eventSeq,
        approval_generation: 1,
      },
    })
    await new GoalObservationRecorder(
      reviewerFixture.goalStore,
    ).recordToolResult({
      expectedGoalId: reviewerFixture.goal.id,
      sessionId: reviewerFixture.goal.scope.sessionId,
      turnId: 'reviewer_turn_risk_command',
      toolCallId: 'reviewer_call_risk_command',
      toolName: 'run_command',
      taskId: reviewerTask.id,
      agentId: reviewerAgentId,
      arguments: { command: 'npm test' },
      evidencePolicy: 'eligible',
      executed: true,
      result: new ToolResultObj({
        modelContent: 'tests passed',
        displaySummary: 'tests passed',
        metadata: { exitCode: 0 },
      }),
    })
    await expect(
      new GoalReviewerCoreRiskAdapter(
        reviewerFixture.planStore,
        reviewerFixture.goalStore,
        reviewerFixture.taskManager.store,
      ).resolve({
        goalId: reviewerFixture.goal.id,
        planId: reviewerFixture.plan.id,
        planEventSeq: reviewerFixture.plan.eventSeq,
      }),
    ).resolves.toMatchObject({
      readonlyProven: false,
      capabilitySignals: ['command_execution'],
    })

    const scopeFixture = await reviewerRiskFixture('goal_risk_scope_change')
    ;(scopeFixture.plan.metadata.scope as Record<string, unknown>)[
      'workspace_root'
    ] = '/different-workspace'
    const mismatchedPlan = scopeFixture.planStore.save(scopeFixture.plan)
    await expect(
      new GoalReviewerCoreRiskAdapter(
        scopeFixture.planStore,
        scopeFixture.goalStore,
        scopeFixture.taskManager.store,
      ).resolve({
        goalId: scopeFixture.goal.id,
        planId: mismatchedPlan.id,
        planEventSeq: mismatchedPlan.eventSeq,
      }),
    ).resolves.toBeNull()

    const writeFixture = await reviewerRiskFixture('goal_risk_hidden_write')
    const executionTask = writeFixture.taskManager.startTask({
      kind: TaskKind.SUBAGENT,
      title: 'Execute Goal implementation',
      source: 'dispatch_subagent',
      sessionId: writeFixture.goal.scope.sessionId,
      metadata: {
        goal_id: writeFixture.goal.id,
        plan_id: writeFixture.plan.id,
        agent_id: 'agent_execution',
      },
    })
    await new GoalObservationRecorder(writeFixture.goalStore).recordToolResult({
      expectedGoalId: writeFixture.goal.id,
      sessionId: writeFixture.goal.scope.sessionId,
      turnId: 'turn_hidden_write',
      toolCallId: 'call_hidden_write',
      toolName: 'write_file',
      taskId: executionTask.id,
      agentId: 'agent_execution',
      arguments: { path: 'hidden.ts', content: 'changed' },
      evidencePolicy: 'context_only',
      executed: true,
      result: new ToolResultObj({
        modelContent: 'file written',
        displaySummary: 'file written',
      }),
    })
    const writeFact = await new GoalReviewerCoreRiskAdapter(
      writeFixture.planStore,
      writeFixture.goalStore,
      writeFixture.taskManager.store,
    ).resolve({
      goalId: writeFixture.goal.id,
      planId: writeFixture.plan.id,
      planEventSeq: writeFixture.plan.eventSeq,
    })
    expect(writeFact).toMatchObject({
      readonlyProven: false,
      changedFiles: [],
      capabilitySignals: ['filesystem_write'],
    })
    expect(
      new GoalReviewerPolicy().requirementFor(writeFixture.plan, writeFact)
        .required,
    ).toBe(true)

    await new GoalObservationRecorder(writeFixture.goalStore).recordToolResult({
      expectedGoalId: writeFixture.goal.id,
      sessionId: writeFixture.goal.scope.sessionId,
      turnId: 'turn_hidden_write_second',
      toolCallId: 'call_hidden_write_second',
      toolName: 'write_file',
      taskId: executionTask.id,
      agentId: 'agent_execution',
      arguments: { path: 'hidden.ts', content: 'changed again' },
      evidencePolicy: 'context_only',
      executed: true,
      result: new ToolResultObj({
        modelContent: 'file written again',
        displaySummary: 'file written again',
      }),
    })
    const advancedWriteFact = await new GoalReviewerCoreRiskAdapter(
      writeFixture.planStore,
      writeFixture.goalStore,
      writeFixture.taskManager.store,
    ).resolve({
      goalId: writeFixture.goal.id,
      planId: writeFixture.plan.id,
      planEventSeq: writeFixture.plan.eventSeq,
    })
    expect(advancedWriteFact?.capabilitySignals).toEqual(['filesystem_write'])
    expect(advancedWriteFact?.version).not.toBe(writeFact?.version)
  })

  it('invalidates R1 at R2 dispatch and recognizes only the completed R2 generation', async () => {
    const fixture = await reviewerRiskFixture('goal_risk_reviewer_frontier', {
      commandCriterion: true,
    })
    const evidenceLedger = new GoalEvidenceLedger(fixture.goalStore)
    const riskAdapter = new GoalReviewerCoreRiskAdapter(
      fixture.planStore,
      fixture.goalStore,
      fixture.taskManager.store,
    )
    const ledger = new GoalReviewerLedger({
      goalStore: fixture.goalStore,
      planStore: fixture.planStore,
      taskManager: fixture.taskManager,
      evidenceLedger,
      resolveRiskFact: (context) => riskAdapter.resolve(context),
    })
    const r1 = await ledger.dispatchGoalReviewer({
      goalId: fixture.goal.id,
      planId: fixture.plan.id,
      planEventSeq: fixture.plan.eventSeq,
    })
    const recorder = new GoalObservationRecorder(fixture.goalStore)
    const r1Observation = await recorder.recordToolResult({
      expectedGoalId: fixture.goal.id,
      sessionId: fixture.goal.scope.sessionId,
      turnId: r1.receipt.turnId,
      toolCallId: 'call_reviewer_r1',
      toolName: 'run_command',
      taskId: r1.task.id,
      agentId: r1.receipt.agentId,
      arguments: { command: 'npm test' },
      evidencePolicy: 'eligible',
      executed: true,
      result: new ToolResultObj({
        modelContent: 'tests passed',
        displaySummary: 'tests passed',
        metadata: { exitCode: 0 },
      }),
    })
    const r1Evidence = await evidenceLedger.record(fixture.goal.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'npm test',
      summary: 'tests passed',
      sourceObservationIds: [r1Observation!.id],
      sourceReceiptIds: [],
    })
    fixture.taskManager.appendSidechain(r1.task.id, {
      role: 'assistant',
      content: [
        '```verdict',
        JSON.stringify({
          passed: true,
          summary: 'R1 passed.',
          commands: ['npm test'],
          command_evidence: [{ evidence_id: r1Evidence.id }],
        }),
        '```',
      ].join('\n'),
    })
    fixture.taskManager.completeGoalReviewerTask(r1.task.id, {
      summary: 'R1 complete',
    })
    const r1Receipt = await ledger.recordReviewerReceipt({
      goalId: fixture.goal.id,
      planId: fixture.plan.id,
      planEventSeq: fixture.plan.eventSeq,
      taskId: r1.task.id,
    })
    await expect(
      ledger.latestReviewerReceipt(fixture.goal.id),
    ).resolves.toEqual(r1Receipt)
    const r1Source = ledger.independentReviewerSource(r1Receipt, 'AC-2')
    await expect(
      ledger.resolveIndependentReviewerFact(fixture.goal.id, r1Source),
    ).resolves.not.toBeNull()
    const before = await riskAdapter.resolve({
      goalId: fixture.goal.id,
      planId: fixture.plan.id,
      planEventSeq: fixture.plan.eventSeq,
      currentReviewer: {
        taskId: r1.task.id,
        agentId: r1.receipt.agentId,
        binding: 'receipt',
      },
    })
    expect(before).toMatchObject({
      readonlyProven: false,
      capabilitySignals: ['command_execution'],
    })
    expect(r1Receipt.riskFactVersion).toBe(before?.version)

    const r2 = await ledger.dispatchGoalReviewer({
      goalId: fixture.goal.id,
      planId: fixture.plan.id,
      planEventSeq: fixture.plan.eventSeq,
    })
    expect(r2.receipt.dispatchOrdinal).toBeGreaterThan(
      r1.receipt.dispatchOrdinal,
    )
    await expect(
      ledger.latestReviewerReceipt(fixture.goal.id),
    ).resolves.toBeNull()
    await expect(
      ledger.latestReviewerDecision(fixture.goal.id),
    ).resolves.toBeNull()
    await expect(
      ledger.resolveIndependentReviewerFact(fixture.goal.id, r1Source),
    ).resolves.toBeNull()
    const r2Observation = await recorder.recordToolResult({
      expectedGoalId: fixture.goal.id,
      sessionId: fixture.goal.scope.sessionId,
      turnId: r2.receipt.turnId,
      toolCallId: 'call_reviewer_r2',
      toolName: 'run_command',
      taskId: r2.task.id,
      agentId: r2.receipt.agentId,
      arguments: { command: 'npm test' },
      evidencePolicy: 'eligible',
      executed: true,
      result: new ToolResultObj({
        modelContent: 'tests passed again',
        displaySummary: 'tests passed again',
        metadata: { exitCode: 0 },
      }),
    })
    const r2Evidence = await evidenceLedger.record(fixture.goal.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'npm test',
      summary: 'tests passed again',
      sourceObservationIds: [r2Observation!.id],
      sourceReceiptIds: [],
    })
    fixture.taskManager.appendSidechain(r2.task.id, {
      role: 'assistant',
      content: [
        '```verdict',
        JSON.stringify({
          passed: true,
          summary: 'R2 passed.',
          commands: ['npm test'],
          command_evidence: [{ evidence_id: r2Evidence.id }],
        }),
        '```',
      ].join('\n'),
    })
    fixture.taskManager.completeGoalReviewerTask(r2.task.id, {
      summary: 'R2 complete',
    })
    const r2Receipt = await ledger.recordReviewerReceipt({
      goalId: fixture.goal.id,
      planId: fixture.plan.id,
      planEventSeq: fixture.plan.eventSeq,
      taskId: r2.task.id,
    })
    await expect(
      ledger.latestReviewerReceipt(fixture.goal.id),
    ).resolves.toEqual(r2Receipt)
    expect(r2Receipt.dispatchReceiptId).toBe(r2.receipt.id)
  })

  it('resolves risk and dispatches from an archived Plan without changing archive bytes', async () => {
    const fixture = await reviewerRiskFixture('goal_risk_archived_plan')
    const archivePath = archivePlan(fixture.planStore, fixture.plan.id)
    const archiveBytes = readFileSync(archivePath)
    const archiveNames = readdirSync(fixture.planStore.archiveDir).sort()
    const adapter = new GoalReviewerCoreRiskAdapter(
      fixture.planStore,
      fixture.goalStore,
      fixture.taskManager.store,
    )

    await expect(
      adapter.resolve({
        goalId: fixture.goal.id,
        planId: fixture.plan.id,
        planEventSeq: fixture.plan.eventSeq,
      }),
    ).resolves.toMatchObject({ readonlyProven: true })
    const ledger = new GoalReviewerLedger({
      goalStore: fixture.goalStore,
      planStore: fixture.planStore,
      taskManager: fixture.taskManager,
      evidenceLedger: new GoalEvidenceLedger(fixture.goalStore),
      resolveRiskFact: (context) => adapter.resolve(context),
    })
    await expect(
      ledger.dispatchGoalReviewer({
        goalId: fixture.goal.id,
        planId: fixture.plan.id,
        planEventSeq: fixture.plan.eventSeq,
      }),
    ).resolves.toMatchObject({
      receipt: { planId: fixture.plan.id },
    })
    expect(readFileSync(archivePath)).toEqual(archiveBytes)
    expect(readdirSync(fixture.planStore.archiveDir).sort()).toEqual(
      archiveNames,
    )
  })
})

describe('GoalReviewerLedger', () => {
  it('does not accept a manually stamped general subagent as a Core reviewer dispatch', async () => {
    const fixture = await reviewerFixture('goal_reviewer_manual_dispatch', {
      manualDispatch: true,
    })

    await expect(
      fixture.ledger.recordReviewerReceipt({
        goalId: fixture.goalId,
        planId: fixture.planId,
        planEventSeq: fixture.planEventSeq,
        taskId: fixture.taskId,
      }),
    ).rejects.toMatchObject({ code: 'goal_reviewer_task_untrusted' })
  })

  it('keeps Core reviewer provenance immutable across ordinary task updates', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-reviewer-task-'))
    const manager = new TaskManager(root)
    expect(() =>
      manager.startTask({
        kind: TaskKind.SUBAGENT,
        title: 'Forged reviewer',
        source: 'goal_reviewer_dispatch',
      }),
    ).toThrow(/Core reviewer Task factory/)
    const task = manager.startGoalReviewerTask({
      kind: TaskKind.SUBAGENT,
      title: 'Core reviewer',
      turnId: 'reviewer_turn_1',
      sessionId: 'session_1',
      metadata: {
        issued_by: 'core',
        agent_type: 'verification_reviewer',
        agent_id: 'reviewer_agent_1',
        turn_id: 'reviewer_turn_1',
        goal_id: 'goal_1',
        plan_id: 'plan_1',
        plan_event_seq: 1,
      },
    })

    expect(() =>
      manager.updateTask(task.id, {
        source: 'dispatch_subagent',
        transcriptPath: 'attacker.jsonl',
        metadata: { goal_id: 'goal_other' },
        status: 'completed',
      }),
    ).toThrow(/Core authority/)
    const forged = TaskRecord.fromDict({
      ...task.toDict(),
      source: 'dispatch_subagent',
    })
    expect(() => manager.store.upsert(forged)).toThrow(/Core authority/)

    const completed = manager.completeGoalReviewerTask(task.id, {
      summary: 'reviewed',
    })!
    expect(completed.status).toBe('completed')
    expect(completed.source).toBe('goal_reviewer_dispatch')
    expect(completed.transcript_path).toBe(task.transcript_path)
    expect(completed.metadata).toEqual(task.metadata)
  })

  it('records one typed receipt from a real terminal reviewer task and revalidates command evidence', async () => {
    const fixture = await reviewerFixture('goal_reviewer_happy')
    const receipt = await fixture.ledger.recordReviewerReceipt({
      goalId: fixture.goalId,
      planId: fixture.planId,
      planEventSeq: fixture.planEventSeq,
      taskId: fixture.taskId,
    })

    expect(receipt).toMatchObject({
      goalId: fixture.goalId,
      planId: fixture.planId,
      verdict: 'pass',
      taskId: fixture.taskId,
      transcriptRef: `task:${fixture.taskId}:transcript`,
      commandEvidenceIds: [fixture.evidenceId],
    })
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt.commandEvidenceIds)).toBe(true)
    expect(await fixture.ledger.latestReviewerReceipt(fixture.goalId)).toEqual(
      receipt,
    )
  })

  it('accepts an archived reviewer Task through pure inspection and fails closed on archive corruption', async () => {
    const fixture = await reviewerFixture('goal_reviewer_archived')
    const archivePath = archiveReviewerTask(fixture.taskManager, fixture.taskId)
    const before = readFileSync(archivePath)
    const names = readdirSync(fixture.taskManager.store.archiveDir).sort()

    const receipt = await fixture.ledger.recordReviewerReceipt({
      goalId: fixture.goalId,
      planId: fixture.planId,
      planEventSeq: fixture.planEventSeq,
      taskId: fixture.taskId,
    })
    expect(receipt.taskId).toBe(fixture.taskId)
    expect(readFileSync(archivePath)).toEqual(before)
    expect(readdirSync(fixture.taskManager.store.archiveDir).sort()).toEqual(
      names,
    )

    const corruptFixture = await reviewerFixture('goal_reviewer_archive_bad')
    const corruptPath = archiveReviewerTask(
      corruptFixture.taskManager,
      corruptFixture.taskId,
    )
    writeFileSync(corruptPath, '{damaged reviewer archive', 'utf8')
    const corruptBytes = readFileSync(corruptPath)
    const corruptNames = readdirSync(
      corruptFixture.taskManager.store.archiveDir,
    ).sort()
    await expect(
      corruptFixture.ledger.recordReviewerReceipt({
        goalId: corruptFixture.goalId,
        planId: corruptFixture.planId,
        planEventSeq: corruptFixture.planEventSeq,
        taskId: corruptFixture.taskId,
      }),
    ).rejects.toMatchObject({ code: 'goal_reviewer_task_untrusted' })
    expect(readFileSync(corruptPath)).toEqual(corruptBytes)
    expect(
      readdirSync(corruptFixture.taskManager.store.archiveDir).sort(),
    ).toEqual(corruptNames)
  })

  it.each([
    ['running task', { keepRunning: true }],
    ['arbitrary task kind', { taskKind: TaskKind.PLAN_STEP }],
    ['cross-Goal task stamp', { stampedGoalId: 'goal_other' }],
    ['cross-Plan task stamp', { stampedPlanId: 'plan_other' }],
    ['unbound main-agent evidence', { unboundEvidence: true }],
    [
      'changed Core risk fact version',
      { changeRiskVersionAfterDispatch: true },
    ],
    ['unknown command evidence', { commandEvidenceIds: ['evidence_forged'] }],
  ] as const)(
    'rejects %s instead of trusting reviewer text or mutable dictionaries',
    async (_label, overrides) => {
      const fixture = await reviewerFixture(
        `goal_reviewer_reject_${String(_label).replaceAll(' ', '_')}`,
        overrides,
      )

      await expect(
        fixture.ledger.recordReviewerReceipt({
          goalId: fixture.goalId,
          planId: fixture.planId,
          planEventSeq: fixture.planEventSeq,
          taskId: fixture.taskId,
        }),
      ).rejects.toBeInstanceOf(GoalReviewerError)
      expect(await fixture.ledger.listReviewerReceipts(fixture.goalId)).toEqual(
        [],
      )
    },
  )

  it('is append-only, unique, and rejects a stale current Plan generation', async () => {
    const fixture = await reviewerFixture('goal_reviewer_unique')
    await fixture.ledger.recordReviewerReceipt({
      goalId: fixture.goalId,
      planId: fixture.planId,
      planEventSeq: fixture.planEventSeq,
      taskId: fixture.taskId,
    })

    await expect(
      fixture.ledger.recordReviewerReceipt({
        goalId: fixture.goalId,
        planId: fixture.planId,
        planEventSeq: fixture.planEventSeq,
        taskId: fixture.taskId,
      }),
    ).rejects.toMatchObject({ code: 'goal_reviewer_receipt_duplicate' })
    await expect(
      fixture.ledger.recordReviewerReceipt({
        goalId: fixture.goalId,
        planId: fixture.planId,
        planEventSeq: fixture.planEventSeq + 1,
        taskId: fixture.taskId,
      }),
    ).rejects.toMatchObject({ code: 'goal_reviewer_plan_stale' })
  })

  it.each([
    ['a mismatched old-generation dispatch binding', 'mismatched'],
    ['a duplicate old-generation decision', 'duplicate'],
  ] as const)(
    'fails the whole frontier closed after %s arrives behind a newer dispatch',
    async (_label, mutation) => {
      const fixture = await reviewerFixture(
        `goal_reviewer_old_generation_${mutation}`,
      )
      const r1 = await fixture.ledger.recordReviewerReceipt({
        goalId: fixture.goalId,
        planId: fixture.planId,
        planEventSeq: fixture.planEventSeq,
        taskId: fixture.taskId,
      })
      await fixture.ledger.dispatchGoalReviewer({
        goalId: fixture.goalId,
        planId: fixture.planId,
        planEventSeq: fixture.planEventSeq,
      })

      const injected =
        mutation === 'duplicate'
          ? r1
          : reviewerReceiptWithIntegrity({
              ...r1,
              id: `${r1.id}_forged`,
              dispatchReceiptId: 'reviewer_dispatch_mismatched',
            })
      await appendReviewerReceiptEvent(fixture.store, fixture.goalId, injected)

      await expect(
        fixture.ledger.latestReviewerReceipt(fixture.goalId),
      ).resolves.toBeNull()
      await expect(
        fixture.ledger.latestReviewerDecision(fixture.goalId),
      ).resolves.toBeNull()
      await expect(
        fixture.ledger.dispatchGoalReviewer({
          goalId: fixture.goalId,
          planId: fixture.planId,
          planEventSeq: fixture.planEventSeq,
        }),
      ).rejects.toMatchObject({ code: 'goal_reviewer_ledger_invalid' })
    },
  )

  it('records a waiver only from an exact persisted explicit user Control action', async () => {
    const fixture = await reviewerFixture('goal_reviewer_waiver')
    const manager = new ControlManager(fixture.root)
    const goal = (await fixture.store.get(fixture.goalId))!
    const interaction = manager.requestGoalReviewerWaiver({
      goal,
      planId: fixture.planId,
      planEventSeq: fixture.planEventSeq,
      riskSignals: new GoalReviewerPolicy().requirementFor(
        fixture.planStore.get(fixture.planId)!,
      ).riskSignals,
      riskFactVersion: null,
      reason: 'Independent verification is unavailable; disclose the risk.',
    })
    manager.answer(interaction.id, {
      goal_reviewer_waiver: {
        choice: GOAL_REVIEWER_WAIVER_APPROVE_LABEL,
        freeform: '',
      },
    })
    const ledger = new GoalReviewerLedger({
      goalStore: fixture.store,
      planStore: fixture.planStore,
      taskManager: fixture.taskManager,
      evidenceLedger: fixture.evidenceLedger,
      now: () => T3,
      idFactory: () => 'review_waiver_typed',
      resolveWaiverAction: (context) =>
        manager.resolveGoalReviewerWaiverAction(goal, context),
    })

    const receipt = await ledger.recordReviewerWaiver({
      goalId: fixture.goalId,
      planId: fixture.planId,
      planEventSeq: fixture.planEventSeq,
      interactionId: interaction.id,
    })

    expect(receipt).toMatchObject({
      goalId: fixture.goalId,
      planId: fixture.planId,
      planEventSeq: fixture.planEventSeq,
      interactionId: interaction.id,
      verdict: 'waived',
      issuedBy: 'core',
      approvedBy: 'user',
    })
    await expect(
      ledger.resolvePlanReviewerFact(fixture.goalId, {
        goalId: fixture.goalId,
        planId: fixture.planId,
        planEventSeq: fixture.planEventSeq,
      }),
    ).resolves.toMatchObject({
      verdict: 'waived',
      receiptId: receipt.id,
    })
    const next = await ledger.dispatchGoalReviewer({
      goalId: fixture.goalId,
      planId: fixture.planId,
      planEventSeq: fixture.planEventSeq,
    })
    expect(next.receipt.dispatchOrdinal).toBe(receipt.dispatchOrdinal + 1)
    await expect(
      ledger.latestReviewerDecision(fixture.goalId),
    ).resolves.toBeNull()

    const delayedR1 = await fixture.ledger.recordReviewerReceipt({
      goalId: fixture.goalId,
      planId: fixture.planId,
      planEventSeq: fixture.planEventSeq,
      taskId: fixture.taskId,
    })
    await expect(
      ledger.latestReviewerDecision(fixture.goalId),
    ).resolves.toBeNull()
    const afterDelayedR1 = await ledger.dispatchGoalReviewer({
      goalId: fixture.goalId,
      planId: fixture.planId,
      planEventSeq: fixture.planEventSeq,
    })
    expect(afterDelayedR1.receipt.dispatchOrdinal).toBe(
      next.receipt.dispatchOrdinal + 1,
    )

    await appendReviewerReceiptEvent(
      fixture.store,
      fixture.goalId,
      reviewerReceiptWithIntegrity({
        ...delayedR1,
        id: `${delayedR1.id}_waiver_forged`,
        dispatchReceiptId: receipt.dispatchReceiptId,
        dispatchOrdinal: receipt.dispatchOrdinal,
      }),
    )
    await expect(
      ledger.dispatchGoalReviewer({
        goalId: fixture.goalId,
        planId: fixture.planId,
        planEventSeq: fixture.planEventSeq,
      }),
    ).rejects.toMatchObject({ code: 'goal_reviewer_ledger_invalid' })
  })

  it('rejects a generic Ask replay of signed reviewer-waiver metadata', async () => {
    const fixture = await reviewerFixture('goal_reviewer_waiver_replay')
    const manager = new ControlManager(fixture.root)
    const goal = (await fixture.store.get(fixture.goalId))!
    const signed = manager.requestGoalReviewerWaiver({
      goal,
      planId: fixture.planId,
      planEventSeq: fixture.planEventSeq,
      riskSignals: new GoalReviewerPolicy().requirementFor(
        fixture.planStore.get(fixture.planId)!,
      ).riskSignals,
      riskFactVersion: null,
      reason: 'Request an exact signed waiver action.',
    })
    manager.answer(signed.id, {
      [GOAL_REVIEWER_WAIVER_QUESTION_ID]: {
        choice: GOAL_REVIEWER_WAIVER_APPROVE_LABEL,
        freeform: '',
      },
    })
    const replay = manager.createAsk({
      questions: signed.questions.map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        options: question.options.map((option) => ({ ...option })),
      })),
      context: signed.context,
      meta: structuredClone(signed.meta),
    })
    manager.answer(replay.id, {
      [GOAL_REVIEWER_WAIVER_QUESTION_ID]: {
        choice: GOAL_REVIEWER_WAIVER_APPROVE_LABEL,
        freeform: '',
      },
    })

    expect(
      manager.resolveGoalReviewerWaiverAction(goal, {
        goalId: goal.id,
        planId: fixture.planId,
        planEventSeq: fixture.planEventSeq,
        interactionId: replay.id,
        riskSignals: new GoalReviewerPolicy().requirementFor(
          fixture.planStore.get(fixture.planId)!,
        ).riskSignals,
        riskFactVersion: null,
      }),
    ).toBeNull()
  })

  it('invalidates a waiver when a same-signal Core risk mutation advances the frontier', async () => {
    const fixture = await reviewerRiskFixture('goal_reviewer_waiver_frontier')
    const observations = new GoalObservationRecorder(fixture.goalStore)
    await observations.recordToolResult({
      expectedGoalId: fixture.goal.id,
      sessionId: fixture.goal.scope.sessionId,
      turnId: 'turn_waiver_frontier_1',
      toolCallId: 'call_waiver_frontier_1',
      toolName: 'write_file',
      arguments: { path: 'first.ts', content: 'first' },
      evidencePolicy: 'context_only',
      executed: true,
      result: new ToolResultObj({
        modelContent: 'first write',
        displaySummary: 'first write',
      }),
    })
    const riskAdapter = new GoalReviewerCoreRiskAdapter(
      fixture.planStore,
      fixture.goalStore,
      fixture.taskManager.store,
    )
    const riskBefore = await riskAdapter.resolve({
      goalId: fixture.goal.id,
      planId: fixture.plan.id,
      planEventSeq: fixture.plan.eventSeq,
    })
    const manager = new ControlManager(fixture.root)
    const interaction = manager.requestGoalReviewerWaiver({
      goal: fixture.goal,
      planId: fixture.plan.id,
      planEventSeq: fixture.plan.eventSeq,
      riskSignals: new GoalReviewerPolicy().requirementFor(
        fixture.plan,
        riskBefore,
      ).riskSignals,
      riskFactVersion: riskBefore?.version ?? null,
      reason: 'Bind the waiver to the current Core risk frontier.',
    })
    manager.answer(interaction.id, {
      [GOAL_REVIEWER_WAIVER_QUESTION_ID]: {
        choice: GOAL_REVIEWER_WAIVER_APPROVE_LABEL,
        freeform: '',
      },
    })
    const ledger = new GoalReviewerLedger({
      goalStore: fixture.goalStore,
      planStore: fixture.planStore,
      taskManager: fixture.taskManager,
      evidenceLedger: new GoalEvidenceLedger(fixture.goalStore),
      resolveRiskFact: (context) => riskAdapter.resolve(context),
      resolveWaiverAction: (context) =>
        manager.resolveGoalReviewerWaiverAction(fixture.goal, context),
    })
    const waiver = await ledger.recordReviewerWaiver({
      goalId: fixture.goal.id,
      planId: fixture.plan.id,
      planEventSeq: fixture.plan.eventSeq,
      interactionId: interaction.id,
    })
    expect(waiver.riskFactVersion).toBe(riskBefore?.version)
    await expect(
      ledger.latestReviewerDecision(fixture.goal.id),
    ).resolves.toEqual(waiver)

    await observations.recordToolResult({
      expectedGoalId: fixture.goal.id,
      sessionId: fixture.goal.scope.sessionId,
      turnId: 'turn_waiver_frontier_2',
      toolCallId: 'call_waiver_frontier_2',
      toolName: 'write_file',
      arguments: { path: 'second.ts', content: 'second' },
      evidencePolicy: 'context_only',
      executed: true,
      result: new ToolResultObj({
        modelContent: 'second write',
        displaySummary: 'second write',
      }),
    })
    const riskAfter = await riskAdapter.resolve({
      goalId: fixture.goal.id,
      planId: fixture.plan.id,
      planEventSeq: fixture.plan.eventSeq,
    })
    expect(riskAfter?.capabilitySignals).toEqual(riskBefore?.capabilitySignals)
    expect(riskAfter?.version).not.toBe(riskBefore?.version)
    await expect(
      ledger.latestReviewerDecision(fixture.goal.id),
    ).resolves.toBeNull()
  })

  it('rejects reason-only, model-authored, declined, or mismatched reviewer waivers', async () => {
    const fixture = await reviewerFixture('goal_reviewer_waiver_reject')
    const manager = new ControlManager(fixture.root)
    const goal = (await fixture.store.get(fixture.goalId))!
    manager.waiveIndependentVerification({
      planId: fixture.planId,
      reason: 'Legacy reason-only waiver must not satisfy a Goal.',
    })
    const interaction = manager.requestGoalReviewerWaiver({
      goal,
      planId: fixture.planId,
      planEventSeq: manager.planStore.get(fixture.planId)!.eventSeq,
      riskSignals: new GoalReviewerPolicy().requirementFor(
        manager.planStore.get(fixture.planId)!,
      ).riskSignals,
      riskFactVersion: null,
      reason: 'Ask the user explicitly.',
    })
    manager.answer(interaction.id, {
      goal_reviewer_waiver: { choice: 'Keep verification required' },
    })
    const ledger = new GoalReviewerLedger({
      goalStore: fixture.store,
      planStore: manager.planStore,
      taskManager: fixture.taskManager,
      evidenceLedger: fixture.evidenceLedger,
      resolveWaiverAction: (context) =>
        manager.resolveGoalReviewerWaiverAction(goal, context),
    })

    await expect(
      ledger.recordReviewerWaiver({
        goalId: fixture.goalId,
        planId: fixture.planId,
        planEventSeq: manager.planStore.get(fixture.planId)!.eventSeq,
        interactionId: interaction.id,
      }),
    ).rejects.toMatchObject({ code: 'goal_reviewer_waiver_untrusted' })
    expect(await ledger.listReviewerWaiverReceipts(fixture.goalId)).toEqual([])
  })
})

type FixtureOverrides = {
  manualDispatch?: boolean
  unboundEvidence?: boolean
  changeRiskVersionAfterDispatch?: boolean
  keepRunning?: boolean
  taskStatus?: string
  taskKind?: string
  stampedGoalId?: string
  stampedPlanId?: string
  commandEvidenceIds?: readonly string[]
}

async function reviewerRiskFixture(
  goalId: string,
  options: { readonly commandCriterion?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'cairn-reviewer-risk-'))
  const goalStore = new GoalStore(root)
  const created = await goalStore.create(
    newGoalRecord({
      id: goalId,
      outcome: 'Assess actual Core execution risk.',
      scope: {
        sessionId: `session_${goalId}`,
        mode: 'build',
        projectId: 'project_risk',
        workspaceRoot: root,
      },
      now: T0,
    }),
  )
  const locked = await goalStore.append(goalId, {
    type: 'goal_updated',
    expectedLastEventSeq: created.lastEventSeq,
    record: GoalContractValidator.lock(
      created,
      {
        inScope: ['risk'],
        outOfScope: [],
        constraints: [],
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'Risk assessment is trustworthy.',
            required: true,
            verification: options.commandCriterion
              ? { kind: 'command', requirement: 'npm test' }
              : { kind: 'manual', requirement: 'inspect risk' },
          },
          ...(options.commandCriterion
            ? [
                {
                  id: 'AC-2',
                  description: 'Independent reviewer approves.',
                  required: true,
                  verification: {
                    kind: 'reviewer' as const,
                    requirement: 'Independent review',
                  },
                },
              ]
            : []),
        ],
        escalationConditions: [],
      },
      T1,
    ),
  })
  const planStore = new PlanStore(root)
  const taskManager = new TaskManager(root)
  const approvedAt = Date.parse(T1) / 1000
  const plan = planStore.save(
    makePlanRecord({
      id: `plan_${goalId}`,
      title: 'Inspect Core state',
      summary: 'Inspect existing state without changes.',
      status: PlanStatus.COMPLETED,
      createdAt: approvedAt - 1,
      updatedAt: approvedAt + 1,
      approvedAt,
      completedAt: approvedAt + 1,
      sessionId: locked.scope.sessionId,
      goalId: locked.id,
      steps: [{ ...step('read', []), commands: [] }],
      metadata: {
        approval_generation: 1,
        scope: {
          session_id: locked.scope.sessionId,
          mode: locked.scope.mode,
          project_id: locked.scope.projectId,
          workspace_root: locked.scope.workspaceRoot,
          project_fingerprint: locked.scope.projectFingerprint,
        },
      },
    }),
  )
  const executing = await goalStore.append(goalId, {
    type: 'goal_updated',
    expectedLastEventSeq: locked.lastEventSeq,
    record: assertGoalTransition(locked, {
      ...locked,
      runtime: {
        ...locked.runtime,
        phase: 'executing',
        currentPlanId: plan.id,
      },
      updatedAt: T2,
    }),
  })
  const goal = await goalStore.append(goalId, {
    type: 'goal_updated',
    expectedLastEventSeq: executing.lastEventSeq,
    record: assertGoalTransition(executing, {
      ...executing,
      runtime: { ...executing.runtime, phase: 'verifying' },
      updatedAt: T3,
    }),
  })
  return { root, goalStore, planStore, taskManager, plan, goal }
}

function archiveReviewerTask(taskManager: TaskManager, taskId: string): string {
  const index = JSON.parse(readFileSync(taskManager.store.indexFile, 'utf8'))
  const payload = index[taskId]
  delete index[taskId]
  writeFileSync(
    taskManager.store.indexFile,
    JSON.stringify(index, null, 2),
    'utf8',
  )
  mkdirSync(taskManager.store.archiveDir, { recursive: true })
  const archivePath = join(taskManager.store.archiveDir, '2026-07.json')
  writeFileSync(
    archivePath,
    JSON.stringify({ [taskId]: payload }, null, 2),
    'utf8',
  )
  return archivePath
}

function archivePlan(planStore: PlanStore, planId: string): string {
  const index = JSON.parse(readFileSync(planStore.indexFile, 'utf8'))
  const payload = index[planId]
  delete index[planId]
  writeFileSync(planStore.indexFile, JSON.stringify(index, null, 2), 'utf8')
  mkdirSync(planStore.archiveDir, { recursive: true })
  const archivePath = join(planStore.archiveDir, '2026-07.json')
  writeFileSync(
    archivePath,
    JSON.stringify({ [planId]: payload }, null, 2),
    'utf8',
  )
  return archivePath
}

async function reviewerFixture(
  goalId: string,
  overrides: FixtureOverrides = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'cairn-goal-reviewer-'))
  const store = new GoalStore(root)
  const created = await store.create(
    newGoalRecord({
      id: goalId,
      outcome: 'Complete a reviewed Goal.',
      scope: {
        sessionId: `session_${goalId}`,
        mode: 'build',
        projectId: 'project_reviewer',
        workspaceRoot: '/workspace/reviewer',
      },
      now: T0,
    }),
  )
  const locked = await store.append(goalId, {
    type: 'goal_updated',
    expectedLastEventSeq: created.lastEventSeq,
    record: GoalContractValidator.lock(
      created,
      {
        inScope: ['reviewer'],
        outOfScope: [],
        constraints: [],
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'Tests pass.',
            required: true,
            verification: { kind: 'command', requirement: 'npm test' },
          },
        ],
        escalationConditions: [],
      },
      T1,
    ),
  })
  const planId = `plan_${goalId}`
  const planStore = new (await import('../plans/store')).PlanStore(root)
  const approvedAt = Date.parse(T1) / 1000
  const plan = planStore.save(
    makePlanRecord({
      id: planId,
      title: 'Backend API release',
      summary: 'Review a security migration release.',
      status: PlanStatus.COMPLETED,
      createdAt: approvedAt - 1,
      updatedAt: approvedAt + 1,
      approvedAt,
      completedAt: approvedAt + 1,
      sessionId: locked.scope.sessionId,
      goalId,
      sourceInteractionId: `plan_interaction_${goalId}`,
      steps: [
        {
          ...step('step_1', [
            'packages/core/src/api/a.ts',
            'packages/core/src/permissions/b.ts',
            'packages/core/src/scheduler/c.ts',
          ]),
          status: PlanStepStatus.DONE,
        },
      ],
      metadata: {
        approval_generation: 1,
        scope: {
          session_id: locked.scope.sessionId,
          mode: locked.scope.mode,
          project_id: locked.scope.projectId,
          workspace_root: locked.scope.workspaceRoot,
          project_fingerprint: locked.scope.projectFingerprint,
        },
      },
    }),
  )
  const executing = await store.append(goalId, {
    type: 'goal_updated',
    expectedLastEventSeq: (await store.get(goalId))!.lastEventSeq,
    record: assertGoalTransition((await store.get(goalId))!, {
      ...(await store.get(goalId))!,
      runtime: {
        ...(await store.get(goalId))!.runtime,
        phase: 'executing',
        currentPlanId: plan.id,
      },
      updatedAt: T2,
    }),
  })
  await store.append(goalId, {
    type: 'goal_updated',
    expectedLastEventSeq: executing.lastEventSeq,
    record: assertGoalTransition(executing, {
      ...executing,
      runtime: { ...executing.runtime, phase: 'verifying' },
      updatedAt: T3,
    }),
  })

  const taskManager = new TaskManager(root)
  const evidence = new GoalEvidenceLedger(store, {
    now: () => T4,
    evidenceIdFactory: () => `evidence_${goalId}`,
  })
  let reviewerNow = T3
  let riskVersion = 'risk:reviewer:1'
  const ledger = new GoalReviewerLedger({
    goalStore: store,
    planStore,
    taskManager,
    evidenceLedger: evidence,
    now: () => reviewerNow,
    idFactory: () => `review_${goalId}`,
    resolveRiskFact: (context) => ({
      ...context,
      kind: 'core_goal_reviewer_risk',
      issuedBy: 'core',
      version: riskVersion,
      readonlyProven: false,
      changedFiles: [],
      capabilitySignals: [],
    }),
  })
  let reviewerAgentId = 'verification_reviewer'
  const task = overrides.manualDispatch
    ? taskManager.startTask({
        kind: TaskKind.SUBAGENT,
        title: 'Independent Goal reviewer',
        source: 'dispatch_subagent',
        sessionId: locked.scope.sessionId,
        metadata: {
          agent_type: 'verification_reviewer',
          goal_id: goalId,
          plan_id: plan.id,
          plan_event_seq: plan.eventSeq,
        },
      })
    : await (async () => {
        const dispatch = await ledger.dispatchGoalReviewer({
          goalId,
          planId: plan.id,
          planEventSeq: plan.eventSeq,
        })
        reviewerAgentId = dispatch.receipt.agentId
        return dispatch.task
      })()
  if (overrides.changeRiskVersionAfterDispatch) riskVersion = 'risk:reviewer:2'
  const observations = new GoalObservationRecorder(store, {
    now: () => T4,
    idFactory: () => `obs_${goalId}`,
  })
  const observation = await observations.recordToolResult({
    expectedGoalId: goalId,
    sessionId: locked.scope.sessionId,
    turnId: task.turn_id ?? `turn_${goalId}`,
    toolCallId: `call_${goalId}`,
    toolName: 'run_command',
    ...(overrides.unboundEvidence
      ? {}
      : { taskId: task.id, agentId: reviewerAgentId }),
    arguments: { command: 'npm test' },
    evidencePolicy: 'eligible',
    executed: true,
    result: new ToolResultObj({
      modelContent: '1 test passed',
      displaySummary: 'tests passed',
      metadata: { exitCode: 0 },
      artifacts: [],
      isError: false,
    }),
  })
  const recorded = await evidence.record(goalId, {
    criterionId: 'AC-1',
    verdict: 'pass',
    check: 'npm test',
    summary: 'tests passed',
    sourceObservationIds: [observation!.id],
    sourceReceiptIds: [],
  })
  const commandEvidenceIds =
    overrides.commandEvidenceIds ?? ([recorded.id] as const)
  taskManager.appendSidechain(task.id, {
    role: 'assistant',
    content: [
      'Independent review complete.',
      '```verdict',
      JSON.stringify({
        passed: true,
        summary: 'All checks passed.',
        commands: ['npm test'],
        command_evidence: commandEvidenceIds.map((id) => ({
          evidence_id: id,
        })),
      }),
      '```',
    ].join('\n'),
  })
  if (
    !overrides.keepRunning &&
    (overrides.taskStatus ?? 'running') === 'running'
  ) {
    if (overrides.manualDispatch)
      taskManager.completeTask(task.id, { summary: 'reviewed' })
    else taskManager.completeGoalReviewerTask(task.id, { summary: 'reviewed' })
  }
  if (
    !overrides.manualDispatch &&
    (overrides.taskKind ||
      overrides.stampedGoalId ||
      overrides.stampedPlanId ||
      overrides.taskStatus)
  ) {
    const persisted = taskManager.store.get(task.id)!
    if (overrides.taskKind) persisted.kind = overrides.taskKind
    if (overrides.stampedGoalId)
      persisted.metadata.goal_id = overrides.stampedGoalId
    if (overrides.stampedPlanId)
      persisted.metadata.plan_id = overrides.stampedPlanId
    if (overrides.taskStatus) persisted.status = overrides.taskStatus
    const index = JSON.parse(readFileSync(taskManager.store.indexFile, 'utf8'))
    index[task.id] = persisted.toDict()
    writeFileSync(
      taskManager.store.indexFile,
      JSON.stringify(index, null, 2),
      'utf8',
    )
  }
  reviewerNow = T5

  return {
    root,
    store,
    planStore,
    taskManager,
    evidenceLedger: evidence,
    goalId,
    planId: plan.id,
    planEventSeq: plan.eventSeq,
    taskId: task.id,
    evidenceId: recorded.id,
    ledger,
  }
}

function reviewerReceiptWithIntegrity(
  receipt: GoalReviewerReceipt,
): GoalReviewerReceipt {
  const { integritySha256: _ignored, ...base } = receipt
  return {
    ...base,
    integritySha256: createHash('sha256')
      .update(canonicalJson(base), 'utf8')
      .digest('hex'),
  }
}

async function appendReviewerReceiptEvent(
  store: GoalStore,
  goalId: string,
  receipt: GoalReviewerReceipt,
): Promise<void> {
  const goal = (await store.get(goalId))!
  await store.append(goalId, {
    type: 'goal_updated',
    expectedLastEventSeq: goal.lastEventSeq,
    record: assertGoalTransition(goal, { ...goal }),
    createdAt: receipt.createdAt,
    data: { reviewerReceipt: receipt as unknown as never },
  })
}

function step(id: string, files: string[]) {
  return {
    id,
    title: id,
    status: PlanStepStatus.DONE,
    dependsOn: [],
    description: '',
    files,
    commands: ['npm test'],
    acceptance: [],
    discoveryRefs: [],
    verification: [],
    evidence: [],
    risk: 'low',
    riskNote: '',
    rollback: '',
  }
}
