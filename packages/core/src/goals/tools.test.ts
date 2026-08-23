import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '../tools/registry'
import type { GoalCompletionGate } from './completion-gate'
import type { GoalEvidenceLedger } from './evidence'
import { newGoalRecord } from './validation'
import { GoalStore } from './store'
import {
  BlockGoalTool,
  CompleteGoalTool,
  DefineGoalContractTool,
  GetGoalTool,
  GOAL_TOOL_NAMES,
  GoalToolHost,
  RecordGoalEvidenceTool,
} from './tools'

const T1 = '2040-01-01T00:00:00.000Z'
const T2 = '2040-01-01T00:00:01.000Z'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'cairn-goal-tools-'))
}

async function fixture(sessionId = 'session_goal') {
  const store = new GoalStore(root())
  const goal = await store.create(
    newGoalRecord({
      id: `goal_${sessionId}`,
      outcome: 'Ship the durable Goal workflow',
      scope: {
        sessionId,
        mode: 'build',
        projectId: 'project_goal',
        workspaceRoot: '/workspace/project',
      },
      now: T1,
    }),
  )
  const evidence = { record: vi.fn() }
  const gate = {
    evaluate: vi.fn(),
    complete: vi.fn(),
  }
  const block = vi.fn()
  const requestPermissionBlockerResolution = vi.fn(() => ({
    id: 'interaction_permission',
  }))
  const host = new GoalToolHost({
    goalStore: store,
    evidenceLedger: evidence as unknown as GoalEvidenceLedger,
    completionGate: gate as unknown as GoalCompletionGate,
    blockGoal: block,
    requestPermissionBlockerResolution,
    now: () => T2,
  })
  return {
    store,
    goal,
    evidence,
    gate,
    block,
    requestPermissionBlockerResolution,
    host,
  }
}

function tools(host: GoalToolHost) {
  return [
    new GetGoalTool(host),
    new DefineGoalContractTool(host),
    new RecordGoalEvidenceTool(host),
    new CompleteGoalTool(host),
    new BlockGoalTool(host),
  ]
}

describe('Goal model tools', () => {
  it('exposes all five tools only for a non-terminal Goal session', async () => {
    const { host } = await fixture()

    await expect(host.visibleToolNames('session_goal')).resolves.toEqual(
      GOAL_TOOL_NAMES,
    )
    await expect(host.visibleToolNames('ordinary_chat')).resolves.toEqual([])
  })

  it('derives Goal authority from ToolExecutionContext and locks the contract', async () => {
    const { host, store, goal } = await fixture()
    const tool = new DefineGoalContractTool(host)

    const result = await tool.execute(
      {
        in_scope: ['packages/core/src/goals'],
        out_of_scope: ['desktop'],
        constraints: ['Preserve disk compatibility'],
        acceptance_criteria: [
          {
            id: 'AC-1',
            description: 'Focused tests pass',
            required: true,
            verification: {
              kind: 'command',
              requirement: 'npm test -- goals/tools.test.ts',
            },
          },
        ],
        escalation_conditions: ['A product decision changes scope'],
      },
      {
        root: '/workspace/project',
        arguments: {},
        sessionId: 'session_goal',
      },
    )

    expect(JSON.parse(String(result))).toMatchObject({
      goalId: goal.id,
      status: 'active',
      phase: 'planning',
      outcome: 'Ship the durable Goal workflow',
    })
    expect((await store.get(goal.id))?.contract.lockedAt).toBe(T2)
    await expect(
      tool.execute(
        {
          in_scope: [],
          out_of_scope: [],
          constraints: [],
          acceptance_criteria: [],
          escalation_conditions: [],
        },
        { root: '', arguments: {}, sessionId: 'another_session' },
      ),
    ).rejects.toMatchObject({ code: 'goal_tool_no_current_goal' })
  })

  it('schemas reject model-supplied authority fields', async () => {
    const { host } = await fixture()
    const registry = new ToolRegistry()
    for (const tool of tools(host)) registry.register(tool)

    expect(() =>
      registry.prepareCall('complete_goal', {
        goalId: 'goal_forged',
        outcome: 'forged',
        status: 'completed',
      }),
    ).toThrow(/unknown field goalId/)
    expect(() =>
      registry.prepareCall('record_goal_evidence', {
        criterion_id: 'AC-1',
        verdict: 'pass',
        check: 'tests',
        summary: 'pass',
        source_observation_ids: ['obs_1'],
        source_receipt_ids: [],
        path: '/tmp/forged',
        hash: 'a'.repeat(64),
        toolName: 'run_command',
      }),
    ).toThrow(/unknown field path/)
  })

  it('records only source IDs against the current Goal', async () => {
    const { host, evidence, goal } = await fixture()
    evidence.record.mockResolvedValue({ id: 'ev_1', criterionId: 'AC-1' })

    const result = await new RecordGoalEvidenceTool(host).execute(
      {
        criterion_id: 'AC-1',
        verdict: 'pass',
        check: 'focused tests',
        summary: '12 tests passed',
        source_observation_ids: ['obs_1'],
        source_receipt_ids: [],
      },
      { root: '', arguments: {}, sessionId: 'session_goal' },
    )

    expect(evidence.record).toHaveBeenCalledWith(
      goal.id,
      {
        criterionId: 'AC-1',
        verdict: 'pass',
        check: 'focused tests',
        summary: '12 tests passed',
        sourceObservationIds: ['obs_1'],
        sourceReceiptIds: [],
      },
      { recorder: 'agent' },
    )
    expect(JSON.parse(String(result))).toEqual({
      evidenceId: 'ev_1',
      criterionId: 'AC-1',
    })
  })

  it('returns stable Gate reason codes and terminal receipt summaries', async () => {
    const { host, gate, goal } = await fixture()
    gate.complete.mockRejectedValue(
      Object.assign(new Error('gate failed'), {
        code: 'goal_completion_gate_failed',
        gate: {
          pass: false,
          reasons: [
            { code: 'criterion_missing_evidence', criterionId: 'AC-1' },
          ],
        },
      }),
    )
    const tool = new CompleteGoalTool(host)

    expect(
      JSON.parse(
        String(
          await tool.execute(
            {},
            {
              root: '',
              arguments: {},
              sessionId: 'session_goal',
            },
          ),
        ),
      ),
    ).toEqual({
      completed: false,
      reasonCodes: ['criterion_missing_evidence'],
    })

    gate.complete.mockResolvedValue({
      goal: {
        ...goal,
        status: 'completed',
        runtime: { ...goal.runtime, phase: 'terminal' },
      },
      receipt: { id: 'receipt_1', evidenceIds: ['ev_1'] },
      gate: { pass: true, reasons: [] },
      postCommitFailures: [],
    })
    expect(
      JSON.parse(
        String(
          await tool.execute(
            {},
            {
              root: '',
              arguments: {},
              sessionId: 'session_goal',
            },
          ),
        ),
      ),
    ).toEqual({
      completed: true,
      goalId: goal.id,
      receiptId: 'receipt_1',
      evidenceIds: ['ev_1'],
      postCommitFailureCodes: [],
    })
  })

  it('derives blocker type and refuses answerable ambiguity or test failures', async () => {
    const { host, requestPermissionBlockerResolution, goal } = await fixture()
    const tool = new BlockGoalTool(host)

    await expect(
      tool.execute(
        {
          reason: 'npm test failed',
          required_permission: null,
        },
        { root: '', arguments: {}, sessionId: 'session_goal' },
      ),
    ).rejects.toMatchObject({ code: 'goal_block_recoverable_failure' })

    await expect(
      tool.execute(
        {
          reason: 'Choose a deployment target',
          required_permission: null,
        },
        { root: '', arguments: {}, sessionId: 'session_goal' },
      ),
    ).rejects.toMatchObject({ code: 'goal_block_permission_required' })

    const result = await tool.execute(
      {
        reason: 'Release permission is unavailable',
        required_permission: 'release:publish',
      },
      { root: '', arguments: {}, sessionId: 'session_goal' },
    )
    expect(JSON.parse(String(result))).toMatchObject({
      blocked: false,
      awaitingUser: true,
      goalId: goal.id,
      interactionId: 'interaction_permission',
    })
    expect(requestPermissionBlockerResolution).toHaveBeenCalledWith(
      goal,
      'Release permission is unavailable',
    )
  })
})
