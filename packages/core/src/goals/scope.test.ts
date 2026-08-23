import { describe, expect, it } from 'vitest'
import { makePlanRecord, PlanStatus } from '../plans/models'
import { planMatchesGoalScope, plansShareFullGoalScope } from './scope'
import type { GoalRecord } from './models'

function goalWithWindowsScope(): GoalRecord {
  return {
    schemaVersion: 'cairn.goal.v1',
    id: 'goal_windows_scope',
    status: 'active',
    scope: {
      sessionId: 'session_windows',
      mode: 'build',
      projectId: 'project_windows',
      workspaceRoot: 'C:/Users/Alice/Cairn',
      projectFingerprint: 'fingerprint_windows',
    },
    contract: {
      outcome: 'Test portable scope matching.',
      inScope: [],
      outOfScope: [],
      constraints: [],
      acceptanceCriteria: [],
      escalationConditions: [],
      lockedAt: '2026-07-15T00:00:00.000Z',
      revision: 1,
    },
    runtime: {
      phase: 'executing',
      cyclesUsed: 0,
      consecutiveNoEvidenceCycles: 0,
      currentRunId: null,
      currentPlanId: 'plan_windows_scope',
      pendingInteractionId: null,
      lastEvidenceAt: null,
      pauseReason: null,
    },
    guardPolicy: {
      maxCycles: null,
      deadlineAt: null,
      maxEstimatedCostUsd: null,
      noEvidencePauseAfterCycles: 3,
    },
    latestEvidenceByCriterion: {},
    supersedesGoalId: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    terminalAt: null,
    lastEventSeq: 1,
  }
}

describe('portable Goal scope matching', () => {
  it('matches Windows drive paths across slash and case representations', () => {
    const goal = goalWithWindowsScope()
    const plan = makePlanRecord({
      id: 'plan_windows_scope',
      title: 'Windows scope',
      summary: 'Portable fixture',
      status: PlanStatus.EXECUTING,
      createdAt: 1,
      updatedAt: 1,
      sessionId: goal.scope.sessionId,
      goalId: goal.id,
      metadata: {
        scope: {
          session_id: goal.scope.sessionId,
          mode: goal.scope.mode,
          project_id: goal.scope.projectId,
          workspace_root: 'c:\\users\\alice\\cairn',
          project_fingerprint: goal.scope.projectFingerprint,
        },
      },
    })

    expect(planMatchesGoalScope(plan, goal)).toBe(true)
    expect(
      plansShareFullGoalScope(plan, {
        ...plan,
        metadata: {
          ...plan.metadata,
          scope: {
            ...(plan.metadata.scope as Record<string, unknown>),
            workspace_root: 'C:/Users/Alice/Cairn',
          },
        },
      }),
    ).toBe(true)
  })

  it('still rejects a different project identity', () => {
    const goal = goalWithWindowsScope()
    const plan = makePlanRecord({
      id: 'plan_windows_wrong_project',
      title: 'Wrong project',
      summary: 'Must fail closed',
      status: PlanStatus.EXECUTING,
      createdAt: 1,
      updatedAt: 1,
      sessionId: goal.scope.sessionId,
      goalId: goal.id,
      metadata: {
        scope: {
          session_id: goal.scope.sessionId,
          mode: goal.scope.mode,
          project_id: 'another-project',
          workspace_root: goal.scope.workspaceRoot,
          project_fingerprint: goal.scope.projectFingerprint,
        },
      },
    })

    expect(planMatchesGoalScope(plan, goal)).toBe(false)
  })

  it('does not rewrite a legal POSIX backslash into a path separator', () => {
    const goal = goalWithWindowsScope()
    const left = makePlanRecord({
      id: 'plan_posix_backslash',
      title: 'POSIX backslash',
      summary: 'Distinct paths remain distinct.',
      status: PlanStatus.EXECUTING,
      createdAt: 1,
      updatedAt: 1,
      sessionId: goal.scope.sessionId,
      goalId: goal.id,
      metadata: {
        scope: {
          session_id: goal.scope.sessionId,
          mode: goal.scope.mode,
          project_id: goal.scope.projectId,
          workspace_root: '/tmp/a\\b',
          project_fingerprint: goal.scope.projectFingerprint,
        },
      },
    })
    const right = {
      ...left,
      metadata: {
        ...left.metadata,
        scope: {
          ...(left.metadata.scope as Record<string, unknown>),
          workspace_root: '/tmp/a/b',
        },
      },
    }
    expect(plansShareFullGoalScope(left, right)).toBe(false)
  })

  it('preserves significant trailing spaces in workspace identity', () => {
    const goal = goalWithWindowsScope()
    const left = makePlanRecord({
      id: 'plan_trailing_space',
      title: 'Trailing space',
      summary: 'Preserve significant path characters',
      status: PlanStatus.EXECUTING,
      createdAt: 1,
      updatedAt: 1,
      sessionId: goal.scope.sessionId,
      goalId: goal.id,
      metadata: {
        scope: {
          session_id: goal.scope.sessionId,
          mode: goal.scope.mode,
          project_id: goal.scope.projectId,
          workspace_root: '/tmp/cairn ',
          project_fingerprint: goal.scope.projectFingerprint,
        },
      },
    })
    const right = {
      ...left,
      metadata: {
        ...left.metadata,
        scope: {
          ...(left.metadata.scope as Record<string, unknown>),
          workspace_root: '/tmp/cairn',
        },
      },
    }

    expect(plansShareFullGoalScope(left, right)).toBe(false)
  })
})
