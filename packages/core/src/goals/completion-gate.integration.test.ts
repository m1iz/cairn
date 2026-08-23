import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GoalStore } from './store'
import { GoalGateMutationLedger } from './mutation-ledger'
import {
  GoalContractValidator,
  assertGoalTransition,
  newGoalRecord,
} from './validation'

const T0 = '2026-07-16T04:00:00.000Z'
const T1 = '2026-07-16T04:01:00.000Z'
const T2 = '2026-07-16T04:02:00.000Z'

describe('Goal terminal integration', () => {
  it('does not re-mint terminal authority from arbitrary constructor options or public writers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-terminal-reentry-'))
    const store = new GoalStore(root, {
      terminalWriterAuthority: Object.freeze({ test: 'forged-authority' }),
    } as never)
    const created = await store.create(
      newGoalRecord({
        id: 'goal_terminal_reentry',
        outcome: 'Finish without a lock inversion.',
        scope: {
          sessionId: 'session_terminal_reentry',
          mode: 'build',
          projectId: 'project_terminal_reentry',
          workspaceRoot: '/workspace/terminal-reentry',
        },
        now: T0,
      }),
    )
    const active = await store.append(created.id, {
      type: 'goal_updated',
      expectedLastEventSeq: created.lastEventSeq,
      record: GoalContractValidator.lock(
        created,
        {
          inScope: ['terminal'],
          outOfScope: [],
          constraints: [],
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'Terminal commit succeeds.',
              required: true,
              verification: { kind: 'command', requirement: 'npm test' },
            },
          ],
          escalationConditions: [],
        },
        T1,
      ),
    })
    const terminal = assertGoalTransition(active, {
      ...active,
      status: 'completed',
      runtime: { ...active.runtime, phase: 'terminal' },
      terminalAt: T2,
      updatedAt: T2,
    })
    const mutationPrecondition = new GoalGateMutationLedger(root).inspect()

    expect(
      (store as unknown as { createTerminalWriter?: unknown })
        .createTerminalWriter,
    ).toBeUndefined()
    await expect(
      store.commitCompletion(active.id, {
        record: terminal,
        expectedLastEventSeq: active.lastEventSeq,
        createdAt: T2,
        data: {},
        mutationPrecondition,
        validatePrecondition: () => {},
      }),
    ).rejects.toMatchObject({ code: 'goal_terminal_write_forbidden' })

    expect((await store.inspect(active.id)).record?.status).toBe('active')
  })
})
