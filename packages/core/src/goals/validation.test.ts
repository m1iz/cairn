import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CairnError } from '../errors'
import {
  GoalContractValidator,
  assertGoalTransition,
  newGoalRecord,
  parseGoalRecord,
  type GoalAcceptanceCriterion,
  type GoalContractDefinition,
  type GoalRecord,
} from './index'

const CREATED_AT = '2026-07-15T10:00:00.000Z'
const LOCKED_AT = '2026-07-15T10:05:00.000Z'

function workspace(): string {
  return join(process.cwd(), '.goal-test-workspaces', 'validation')
}

function criterion(
  id: string,
  kind: GoalAcceptanceCriterion['verification']['kind'] = 'command',
  required = true,
): GoalAcceptanceCriterion {
  return {
    id,
    description: `Verify ${id}`,
    required,
    verification: { kind, requirement: `check ${id}` },
  }
}

function draft(): GoalRecord {
  return newGoalRecord({
    id: 'goal_validation',
    outcome: 'preserve this exact user Outcome',
    scope: {
      sessionId: 'session-validation',
      mode: 'build',
      projectId: 'project-validation',
      workspaceRoot: workspace(),
    },
    now: CREATED_AT,
  })
}

function completeDefinition(): GoalContractDefinition {
  return {
    inScope: [' src ', 'src', 'Documentation'],
    outOfScope: [' dist ', 'vendor'],
    constraints: [' no Python ', '', 'no python', 'keep IPC typed'],
    acceptanceCriteria: [
      criterion('AC-1', 'command'),
      criterion('AC-2', 'artifact'),
      criterion('AC-3', 'manual', false),
      criterion('AC-4', 'reviewer'),
    ],
    escalationConditions: ['permission denied', ' permission denied ', ''],
  }
}

function caught(run: () => unknown): CairnError {
  try {
    run()
    throw new Error('expected Goal operation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(CairnError)
    return error as CairnError
  }
}

function expectDeepFrozen(value: unknown): void {
  if (!value || typeof value !== 'object') return
  expect(Object.isFrozen(value)).toBe(true)
  for (const nested of Object.values(value)) expectDeepFrozen(nested)
}

describe('Goal validation dependency boundary', () => {
  it('does not load the fs-backed shared path utility', () => {
    const source = readFileSync(
      new URL('./validation.ts', import.meta.url),
      'utf8',
    )

    expect(source).not.toMatch(/from ['"]\.\.\/util\/paths['"]/)
    expect(source).not.toMatch(/from ['"]node:fs['"]/)
  })
})

describe('Goal contract validation', () => {
  it('locks a complete contract atomically and normalizes lists without changing Outcome', () => {
    const original = draft()
    const snapshot = structuredClone(original)

    const locked = GoalContractValidator.lock(
      original,
      completeDefinition(),
      LOCKED_AT,
    )

    expect(original).toEqual(snapshot)
    expect(locked.status).toBe('active')
    expect(locked.runtime.phase).toBe('planning')
    expect(locked.contract).toEqual({
      outcome: 'preserve this exact user Outcome',
      inScope: ['src', 'Documentation'],
      outOfScope: ['dist', 'vendor'],
      constraints: ['no Python', 'keep IPC typed'],
      acceptanceCriteria: completeDefinition().acceptanceCriteria,
      escalationConditions: ['permission denied'],
      lockedAt: LOCKED_AT,
      revision: 1,
    })
    expect(locked.updatedAt).toBe(LOCKED_AT)
    expectDeepFrozen(locked)
  })

  it('prevents in-place mutation of a locked Contract', () => {
    const locked = GoalContractValidator.lock(
      draft(),
      completeDefinition(),
      LOCKED_AT,
    )
    const mutable = locked as unknown as {
      contract: { constraints: string[]; lockedAt: string | null }
    }

    expect(() => {
      mutable.contract.constraints.push('tampered')
    }).toThrow(TypeError)
    expect(() => {
      mutable.contract.lockedAt = null
    }).toThrow(TypeError)
    expect(locked.contract.constraints).toEqual(['no Python', 'keep IPC typed'])
  })

  it('rejects define_goal_contract attempts to supply or override Outcome', () => {
    const original = draft()
    const malicious = {
      ...completeDefinition(),
      outcome: 'replace the user Outcome',
    } as GoalContractDefinition

    expect(
      caught(() => GoalContractValidator.lock(original, malicious, LOCKED_AT))
        .code,
    ).toBe('goal_outcome_immutable')
    expect(original.contract.outcome).toBe('preserve this exact user Outcome')
  })

  it('rejects normalized overlap between in-scope and out-of-scope entries', () => {
    const original = draft()
    const definition: GoalContractDefinition = {
      ...completeDefinition(),
      outOfScope: ['SRC'],
    }

    expect(
      caught(() => GoalContractValidator.lock(original, definition, LOCKED_AT))
        .code,
    ).toBe('goal_scope_conflict')
    expect(original.contract.lockedAt).toBeNull()
  })

  it.each([
    {
      name: 'duplicate IDs',
      criteria: [criterion('AC-1'), criterion('AC-1')],
      code: 'goal_acceptance_id_duplicate',
    },
    {
      name: 'skipped sequence',
      criteria: [criterion('AC-1'), criterion('AC-3')],
      code: 'goal_acceptance_sequence_invalid',
    },
    {
      name: 'empty verification requirement',
      criteria: [
        {
          ...criterion('AC-1'),
          verification: { kind: 'command' as const, requirement: '   ' },
        },
      ],
      code: 'goal_acceptance_requirement_invalid',
    },
    {
      name: 'no required criterion',
      criteria: [criterion('AC-1', 'manual', false)],
      code: 'goal_acceptance_required_missing',
    },
  ])('returns a stable code for $name', ({ criteria, code }) => {
    const original = draft()
    const definition: GoalContractDefinition = {
      ...completeDefinition(),
      acceptanceCriteria: criteria,
    }

    expect(
      caught(() => GoalContractValidator.lock(original, definition, LOCKED_AT))
        .code,
    ).toBe(code)
    expect(original.contract.lockedAt).toBeNull()
  })

  it('does not overwrite a contract on a second lock', () => {
    const locked = GoalContractValidator.lock(
      draft(),
      completeDefinition(),
      LOCKED_AT,
    )
    const snapshot = structuredClone(locked)

    expect(
      caught(() =>
        GoalContractValidator.lock(
          locked,
          { ...completeDefinition(), constraints: ['different'] },
          '2026-07-15T10:10:00.000Z',
        ),
      ).code,
    ).toBe('goal_contract_locked')
    expect(locked).toEqual(snapshot)
  })

  it.each([
    { policy: { maxCycles: 0 }, valid: false },
    { policy: { maxCycles: 1 }, valid: true },
    { policy: { maxEstimatedCostUsd: -1 }, valid: false },
    { policy: { maxEstimatedCostUsd: 0.01 }, valid: true },
    { policy: { noEvidencePauseAfterCycles: 0 }, valid: false },
    { policy: { noEvidencePauseAfterCycles: 20 }, valid: true },
    { policy: { noEvidencePauseAfterCycles: 21 }, valid: false },
    { policy: { deadlineAt: 'not-a-timestamp' }, valid: false },
    { policy: { deadlineAt: '2026-08-01T00:00:00.000Z' }, valid: true },
  ])('validates guard policy $policy', ({ policy, valid }) => {
    const create = () =>
      newGoalRecord({
        id: 'goal_guard',
        outcome: 'guard this Goal',
        scope: {
          sessionId: 'session-guard',
          mode: 'chat',
          projectId: null,
          workspaceRoot: workspace(),
        },
        guardPolicy: policy,
        now: CREATED_AT,
      })

    if (valid) expect(create().guardPolicy).toMatchObject(policy)
    else expect(caught(create).code).toBe('goal_guard_policy_invalid')
  })
})

describe('Goal state transitions', () => {
  it('accepts the documented forward phase path', () => {
    const planning = GoalContractValidator.lock(
      draft(),
      completeDefinition(),
      LOCKED_AT,
    )
    const executing: GoalRecord = {
      ...planning,
      runtime: { ...planning.runtime, phase: 'executing' },
    }
    const verifying: GoalRecord = {
      ...executing,
      runtime: { ...executing.runtime, phase: 'verifying' },
    }
    const completed: GoalRecord = {
      ...verifying,
      status: 'completed',
      runtime: { ...verifying.runtime, phase: 'terminal' },
      terminalAt: '2026-07-15T10:20:00.000Z',
      updatedAt: '2026-07-15T10:20:00.000Z',
    }

    const executingSnapshot = assertGoalTransition(planning, executing)
    const verifyingSnapshot = assertGoalTransition(executing, verifying)
    const completedSnapshot = assertGoalTransition(verifying, completed)

    expect(executingSnapshot).toEqual(executing)
    expect(executingSnapshot).not.toBe(executing)
    expect(verifyingSnapshot).toEqual(verifying)
    expect(verifyingSnapshot).not.toBe(verifying)
    expect(completedSnapshot).toEqual(completed)
    expect(completedSnapshot).not.toBe(completed)
    expectDeepFrozen(executingSnapshot)
    expectDeepFrozen(verifyingSnapshot)
    expectDeepFrozen(completedSnapshot)
  })

  it('rejects a same-reference transition even for an otherwise valid snapshot', () => {
    const current = GoalContractValidator.lock(
      draft(),
      completeDefinition(),
      LOCKED_AT,
    )

    expect(caught(() => assertGoalTransition(current, current)).code).toBe(
      'goal_transition_invalid',
    )
  })

  it('rejects terminal-to-active transitions and preserves both records', () => {
    const planning = GoalContractValidator.lock(
      draft(),
      completeDefinition(),
      LOCKED_AT,
    )
    const cancelled: GoalRecord = {
      ...planning,
      status: 'cancelled',
      runtime: { ...planning.runtime, phase: 'terminal' },
      terminalAt: '2026-07-15T10:20:00.000Z',
      updatedAt: '2026-07-15T10:20:00.000Z',
    }
    assertGoalTransition(planning, cancelled)
    const resumed: GoalRecord = {
      ...cancelled,
      status: 'active',
      runtime: { ...cancelled.runtime, phase: 'planning' },
      terminalAt: null,
      updatedAt: '2026-07-15T10:21:00.000Z',
    }
    const before = structuredClone(cancelled)
    const after = structuredClone(resumed)

    expect(caught(() => assertGoalTransition(cancelled, resumed)).code).toBe(
      'goal_transition_invalid',
    )
    expect(cancelled).toEqual(before)
    expect(resumed).toEqual(after)
  })

  it('rejects scope changes without leaking the changed path', () => {
    const current = draft()
    const next: GoalRecord = {
      ...current,
      scope: { ...current.scope, workspaceRoot: '/private/secret/other' },
    }
    const error = caught(() => assertGoalTransition(current, next))

    expect(error.code).toBe('goal_scope_immutable')
    expect(JSON.stringify(error.toSafe())).not.toContain(
      '/private/secret/other',
    )
  })

  it('compares immutable scope by value rather than object key order', () => {
    const current = draft()
    const next: GoalRecord = {
      ...current,
      scope: {
        workspaceRoot: current.scope.workspaceRoot,
        projectFingerprint: current.scope.projectFingerprint,
        projectId: current.scope.projectId,
        mode: current.scope.mode,
        sessionId: current.scope.sessionId,
      },
    }

    expect(() => assertGoalTransition(current, next)).not.toThrow()
  })

  it('rejects locked Contract changes', () => {
    const current = GoalContractValidator.lock(
      draft(),
      completeDefinition(),
      LOCKED_AT,
    )
    const next: GoalRecord = {
      ...current,
      contract: { ...current.contract, constraints: ['rewritten'] },
    }

    expect(caught(() => assertGoalTransition(current, next)).code).toBe(
      'goal_contract_immutable',
    )
  })

  it('allows restart recovery to pause a verifying Goal without widening other transitions', () => {
    const planning = GoalContractValidator.lock(
      draft(),
      completeDefinition(),
      LOCKED_AT,
    )
    const executing = assertGoalTransition(planning, {
      ...planning,
      runtime: { ...planning.runtime, phase: 'executing' },
      updatedAt: '2026-07-15T10:20:00.000Z',
    })
    const verifying = assertGoalTransition(executing, {
      ...executing,
      runtime: { ...executing.runtime, phase: 'verifying' },
      updatedAt: '2026-07-15T10:21:00.000Z',
    })

    const paused = assertGoalTransition(verifying, {
      ...verifying,
      runtime: {
        ...verifying.runtime,
        phase: 'paused',
        pauseReason: 'recovery_required',
      },
      updatedAt: '2026-07-15T10:22:00.000Z',
    })

    expect(paused.runtime).toMatchObject({
      phase: 'paused',
      pauseReason: 'recovery_required',
    })
    expectDeepFrozen(paused)
  })

  it.each([
    { status: 'active', phase: 'terminal' },
    { status: 'completed', phase: 'executing' },
    { status: 'draft', phase: 'planning' },
  ])('rejects invalid $status + $phase combinations', ({ status, phase }) => {
    const raw = structuredClone(draft()) as unknown as Record<string, unknown>
    raw.status = status
    ;(raw.runtime as Record<string, unknown>).phase = phase
    if (status === 'completed') raw.terminalAt = LOCKED_AT

    expect(caught(() => parseGoalRecord(raw)).code).toBe(
      'goal_state_combination_invalid',
    )
  })
})
