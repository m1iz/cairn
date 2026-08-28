export interface LongMemEvalRanking {
  expectedSessionIds: readonly string[]
  retrievedSessionIds: readonly string[]
  latencyMs: number
}

export interface LongMemEvalRetrievalMetrics {
  caseCount: number
  hitAt1: number
  hitAt3: number
  hitAt5: number
  recallAt1: number
  recallAt3: number
  recallAt5: number
  mrrAt5: number
  ndcgAt5: number
  p50LatencyMs: number
  p95LatencyMs: number
}

/** Deterministic session-level retrieval metrics used by LongMemEval. */
export function scoreLongMemEvalRankings(
  rankings: readonly LongMemEvalRanking[],
): LongMemEvalRetrievalMetrics {
  let hitsAt1 = 0
  let hitsAt3 = 0
  let hitsAt5 = 0
  let recallAt1 = 0
  let recallAt3 = 0
  let recallAt5 = 0
  let reciprocalRankAt5 = 0
  let ndcgAt5 = 0
  const latencies: number[] = []

  for (const ranking of rankings) {
    const expected = new Set(uniqueStrings(ranking.expectedSessionIds))
    const retrieved = uniqueStrings(ranking.retrievedSessionIds).slice(0, 5)
    const relevance = retrieved.map((id) => (expected.has(id) ? 1 : 0))
    if (relevance[0] === 1) hitsAt1 += 1
    if (relevance.slice(0, 3).some(Boolean)) hitsAt3 += 1
    if (relevance.some(Boolean)) hitsAt5 += 1
    recallAt1 += recallAt(relevance, expected.size, 1)
    recallAt3 += recallAt(relevance, expected.size, 3)
    recallAt5 += recallAt(relevance, expected.size, 5)
    const firstRelevant = relevance.findIndex(Boolean)
    if (firstRelevant >= 0) reciprocalRankAt5 += 1 / (firstRelevant + 1)
    ndcgAt5 += normalizedDiscountedCumulativeGain(relevance, expected.size)
    latencies.push(Math.max(0, Number(ranking.latencyMs) || 0))
  }

  const count = rankings.length
  return {
    caseCount: count,
    hitAt1: rate(hitsAt1, count),
    hitAt3: rate(hitsAt3, count),
    hitAt5: rate(hitsAt5, count),
    recallAt1: count ? recallAt1 / count : 0,
    recallAt3: count ? recallAt3 / count : 0,
    recallAt5: count ? recallAt5 / count : 0,
    mrrAt5: count ? reciprocalRankAt5 / count : 0,
    ndcgAt5: count ? ndcgAt5 / count : 0,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  }
}

function recallAt(
  relevance: readonly number[],
  expectedCount: number,
  limit: number,
): number {
  if (!expectedCount) return 0
  return (
    relevance.slice(0, limit).reduce<number>((sum, value) => sum + value, 0) /
    expectedCount
  )
}

function normalizedDiscountedCumulativeGain(
  relevance: readonly number[],
  expectedCount: number,
): number {
  const dcg = relevance.reduce(
    (sum, value, index) => sum + value / Math.log2(index + 2),
    0,
  )
  const idealLength = Math.min(relevance.length, expectedCount)
  let ideal = 0
  for (let index = 0; index < idealLength; index += 1)
    ideal += 1 / Math.log2(index + 2)
  return ideal ? dcg / ideal : 0
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(String).filter(Boolean))]
}

function rate(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 0
}

function percentile(values: readonly number[], quantile: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  )
  return Number(sorted[index]!.toFixed(3))
}
