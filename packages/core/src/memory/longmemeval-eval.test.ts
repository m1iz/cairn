import { describe, expect, it } from 'vitest'
import { scoreLongMemEvalRankings } from './longmemeval-eval'

describe('LongMemEval retrieval metrics', () => {
  it('scores ranked multi-evidence sessions and latency deterministically', () => {
    const metrics = scoreLongMemEvalRankings([
      {
        expectedSessionIds: ['a', 'b'],
        retrievedSessionIds: ['a', 'noise', 'b'],
        latencyMs: 10,
      },
      {
        expectedSessionIds: ['c'],
        retrievedSessionIds: ['noise', 'c'],
        latencyMs: 20,
      },
      {
        expectedSessionIds: ['d'],
        retrievedSessionIds: ['noise'],
        latencyMs: 30,
      },
    ])

    expect(metrics).toMatchObject({
      caseCount: 3,
      hitAt1: 1 / 3,
      hitAt3: 2 / 3,
      hitAt5: 2 / 3,
      recallAt1: 1 / 6,
      recallAt3: 2 / 3,
      recallAt5: 2 / 3,
      mrrAt5: 0.5,
      p50LatencyMs: 20,
      p95LatencyMs: 30,
    })
    expect(metrics.ndcgAt5).toBeGreaterThan(0.5)
    expect(metrics.ndcgAt5).toBeLessThan(1)
  })

  it('returns finite zero metrics for an empty input', () => {
    expect(scoreLongMemEvalRankings([])).toEqual({
      caseCount: 0,
      hitAt1: 0,
      hitAt3: 0,
      hitAt5: 0,
      recallAt1: 0,
      recallAt3: 0,
      recallAt5: 0,
      mrrAt5: 0,
      ndcgAt5: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
    })
  })
})
