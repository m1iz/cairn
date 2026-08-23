import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAuthorizedGoalCompletionGate } from '../agent/goal-completion-gate-internal'
import { makePlanRecord, PlanStatus, PlanStepStatus } from '../plans/models'
import { PlanStore } from '../plans/store'
import { TaskManager } from '../tasks/manager'
import { ToolResultObj } from '../tools/base'
import { GoalEvidenceLedger, GoalObservationRecorder } from './evidence'
import { GoalGateFactStore } from './gate-facts'
import { GoalPlanBridge } from './plan-bridge'
import { GoalReviewerLedger } from './reviewer'
import { GoalStore } from './store'
import {
  GoalContractValidator,
  assertGoalTransition,
  newGoalRecord,
} from './validation'

const T0 = '2026-07-16T08:00:00.000Z'
const T1 = '2026-07-16T08:01:00.000Z'
const T2 = '2026-07-16T08:02:00.000Z'
const T3 = '2026-07-16T08:03:00.000Z'

describe('GoalCompletionGate real terminal path', () => {
  it('completes through real PlanBridge, ReviewerLedger, FactStore, and terminal recheck within five seconds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-real-gate-'))
    const goalStore = new GoalStore(root)
    const created = await goalStore.create(
      newGoalRecord({
        id: 'goal_real_terminal_gate',
        outcome: 'Write the real deterministic terminal event.',
        scope: {
          sessionId: 'session_real_terminal_gate',
          mode: 'build',
          projectId: 'project_real_terminal_gate',
          workspaceRoot: root,
        },
        now: T0,
      }),
    )
    const locked = await goalStore.append(created.id, {
      type: 'goal_updated',
      expectedLastEventSeq: created.lastEventSeq,
      record: GoalContractValidator.lock(
        created,
        {
          inScope: ['real terminal gate'],
          outOfScope: [],
          constraints: [],
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'Core verification command passes.',
              required: true,
              verification: { kind: 'command', requirement: 'npm test' },
            },
          ],
          escalationConditions: [],
        },
        T1,
      ),
    })
    const planStore = new PlanStore(root)
    const plan = planStore.save(
      makePlanRecord({
        id: 'plan_real_terminal_gate',
        title: 'Complete real Goal gate',
        summary: 'Run the exact verification and complete.',
        status: PlanStatus.COMPLETED,
        createdAt: 1,
        updatedAt: 3,
        approvedAt: 2,
        completedAt: 3,
        sessionId: locked.scope.sessionId,
        goalId: locked.id,
        sourceInteractionId: 'interaction_real_terminal_gate',
        steps: [
          {
            id: 'step_1',
            title: 'Verify',
            status: PlanStepStatus.DONE,
            dependsOn: [],
            description: '',
            files: [],
            commands: ['npm test'],
            acceptance: ['tests pass'],
            discoveryRefs: [],
            verification: [],
            evidence: [],
            risk: 'low',
            riskNote: '',
            rollback: '',
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
    const executing = await goalStore.append(locked.id, {
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
    let goal = await goalStore.append(executing.id, {
      type: 'goal_updated',
      expectedLastEventSeq: executing.lastEventSeq,
      record: assertGoalTransition(executing, {
        ...executing,
        runtime: { ...executing.runtime, phase: 'verifying' },
        updatedAt: T3,
      }),
    })
    const observationRecorder = new GoalObservationRecorder(goalStore)
    const observation = await observationRecorder.recordToolResult({
      expectedGoalId: goal.id,
      sessionId: goal.scope.sessionId,
      turnId: 'turn_real_terminal_gate',
      toolCallId: 'call_real_terminal_gate',
      toolName: 'run_command',
      arguments: { command: 'npm test' },
      evidencePolicy: 'eligible',
      executed: true,
      result: new ToolResultObj({
        modelContent: 'tests passed',
        displaySummary: 'tests passed',
        metadata: { exitCode: 0 },
      }),
    })
    const evidenceLedger = new GoalEvidenceLedger(goalStore)
    const evidence = await evidenceLedger.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'npm test',
      summary: 'tests passed',
      sourceObservationIds: [observation!.id],
      sourceReceiptIds: [],
    })
    goal = (await goalStore.get(goal.id))!
    const riskFact = (context: {
      goalId: string
      planId: string
      planEventSeq: number
    }) => ({
      ...context,
      kind: 'core_goal_reviewer_risk' as const,
      issuedBy: 'core' as const,
      version: 'risk:real-readonly:1',
      readonlyProven: true,
      changedFiles: [],
      capabilitySignals: [],
    })
    const taskManager = new TaskManager(root)
    const reviewerLedger = new GoalReviewerLedger({
      goalStore,
      planStore,
      taskManager,
      evidenceLedger,
      resolveRiskFact: riskFact,
    })
    const planBridge = new GoalPlanBridge({
      goalStore,
      planStore,
      taskManager,
      resolveStepVerification: (context) => ({
        ...context,
        kind: 'core_plan_step_verification',
        issuedBy: 'core',
        verdict: 'pass',
        receiptId: `verification_${context.requirementId}`,
      }),
      resolveReviewer: (context) =>
        reviewerLedger.resolvePlanReviewerFact(context.goalId, context),
      resolveReviewerRiskFact: riskFact,
    })
    const factStore = new GoalGateFactStore(root, { now: () => T3 })
    factStore.recordBundle(goal, {
      runtime: { pendingInteractionId: null, directlyAnswerable: false },
      scope: { matches: true },
      storage: { healthy: true },
      hardConstraints: { satisfied: true },
      cost: { estimatedCostUsd: 0 },
    })
    const gate = createAuthorizedGoalCompletionGate({
      goalStore,
      planBridge,
      evidenceLedger,
      reviewerLedger,
      factStore,
      blockerFactStore: new (
        await import('./blocker-facts')
      ).GoalBlockerFactStore(root),
      now: () => T3,
    })

    const outcome = await Promise.race([
      gate.complete(goal.id),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('real Gate timed out')), 5_000),
      ),
    ])

    expect(outcome.goal.status).toBe('completed')
    expect(outcome.receipt.evidenceIds).toEqual([evidence.id])
    expect((await goalStore.get(goal.id))?.status).toBe('completed')

    const archivePath = join(planStore.archiveDir, 'damaged-plan.json')
    mkdirSync(planStore.archiveDir, { recursive: true })
    writeFileSync(archivePath, '{damaged archive', 'utf8')
    const archivedBytes = readFileSync(archivePath)
    const archivedNames = readdirSync(planStore.archiveDir).sort()
    const archiveEvaluation = await gate.evaluate(goal.id)
    expect(archiveEvaluation.reasons.map((reason) => reason.code)).toContain(
      'plan_missing',
    )
    expect(readFileSync(archivePath)).toEqual(archivedBytes)
    expect(readdirSync(planStore.archiveDir).sort()).toEqual(archivedNames)

    rmSync(archivePath)
    writeFileSync(planStore.quarantineFile, '{damaged quarantine', 'utf8')
    const quarantineBytes = readFileSync(planStore.quarantineFile)
    const quarantineEvaluation = await gate.evaluate(goal.id)
    expect(quarantineEvaluation.reasons.map((reason) => reason.code)).toContain(
      'plan_missing',
    )
    expect(readFileSync(planStore.quarantineFile)).toEqual(quarantineBytes)
  }, 10_000)
})
