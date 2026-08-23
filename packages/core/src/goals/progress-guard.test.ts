import { describe, expect, it } from 'vitest'
import { GoalProgressGuard, type GoalProgressSnapshot } from './progress-guard'

const snapshot = (
  patch: Partial<GoalProgressSnapshot> = {},
): GoalProgressSnapshot => ({
  lastEventSeq: 4,
  planUpdatedAt: '2026-07-16T00:00:00.000Z',
  activePlanStepId: 'step-1',
  activePlanStepStatus: 'active',
  evidenceIds: ['evidence-1'],
  observationCount: 2,
  pendingInteractionId: null,
  ...patch,
})

describe('GoalProgressGuard', () => {
  it('pauses after three cycles without durable progress', () => {
    const guard = new GoalProgressGuard()
    const first = guard.assessCycle({
      before: snapshot(),
      after: snapshot(),
      previousConsecutiveNoEvidenceCycles: 0,
    })
    const third = guard.assessCycle({
      before: snapshot(),
      after: snapshot(),
      previousConsecutiveNoEvidenceCycles: 2,
    })
    expect(first).toMatchObject({
      progressed: false,
      consecutiveNoEvidenceCycles: 1,
      shouldPause: false,
    })
    expect(third).toMatchObject({
      progressed: false,
      consecutiveNoEvidenceCycles: 3,
      shouldPause: true,
    })
  })

  it('uses only durable fields and canonicalizes evidence order', () => {
    const guard = new GoalProgressGuard()
    expect(
      guard.signature(snapshot({ evidenceIds: ['evidence-2', 'evidence-1'] })),
    ).toBe(
      guard.signature(snapshot({ evidenceIds: ['evidence-1', 'evidence-2'] })),
    )
    expect(
      guard.assessCycle({
        before: snapshot(),
        after: snapshot({ observationCount: 3 }),
        previousConsecutiveNoEvidenceCycles: 2,
      }),
    ).toMatchObject({
      progressed: true,
      consecutiveNoEvidenceCycles: 0,
      shouldPause: false,
    })
  })

  it('counts FAIL evidence, explicit replans, and user decisions as progress', () => {
    const guard = new GoalProgressGuard()
    for (const marker of [
      { failedEvidenceRecorded: true },
      { explicitReplan: true },
      { userDecisionRecorded: true },
    ]) {
      expect(
        guard.assessCycle({
          before: snapshot(),
          after: snapshot(),
          previousConsecutiveNoEvidenceCycles: 2,
          ...marker,
        }),
      ).toMatchObject({ progressed: true, consecutiveNoEvidenceCycles: 0 })
    }
  })
})
