export interface RankedMemoryCandidate {
  id: string
  text: string
  lexicalScore: number
  vectorScore: number
  lexicalRank?: number
  vectorRank?: number
  fusedScore?: number
  rerankerScore?: number | null
}

export interface MemoryReranker {
  readonly id: string
  rerank(
    query: string,
    candidates: readonly RankedMemoryCandidate[],
    options?: { signal?: AbortSignal; topN?: number },
  ): Promise<Map<string, number>>
}

export interface MemoryAdmissionConfig {
  enabled: boolean
  minRerankerScore: number
  minVectorScore: number
  minLexicalScore: number
  requireSignalAgreement: boolean
}

export interface MemoryAdmissionDecision {
  admitted: boolean
  reason:
    | 'admission_disabled'
    | 'reranker_passed'
    | 'strong_lexical_match'
    | 'strong_vector_match'
    | 'signal_agreement'
    | 'below_relevance_threshold'
}

export function reciprocalRankFusion<T extends RankedMemoryCandidate>(
  candidates: readonly T[],
  rankConstant = 60,
): Array<T & { fusedScore: number }> {
  const k = Math.max(1, Math.trunc(rankConstant))
  const lexical = [...candidates]
    .filter((candidate) => candidate.lexicalScore > 0)
    .sort(scoreOrder('lexicalScore'))
  const vector = [...candidates]
    .filter((candidate) => candidate.vectorScore > 0)
    .sort(scoreOrder('vectorScore'))
  const lexicalRanks = rankMap(lexical)
  const vectorRanks = rankMap(vector)
  return candidates
    .map((candidate) => {
      const lexicalRank = lexicalRanks.get(candidate.id)
      const vectorRank = vectorRanks.get(candidate.id)
      return {
        ...candidate,
        lexicalRank,
        vectorRank,
        fusedScore:
          (lexicalRank ? 1 / (k + lexicalRank) : 0) +
          (vectorRank ? 1 / (k + vectorRank) : 0),
      }
    })
    .filter((candidate) => (candidate.fusedScore ?? 0) > 0)
    .sort(
      (left, right) =>
        (right.fusedScore ?? 0) - (left.fusedScore ?? 0) ||
        left.id.localeCompare(right.id),
    ) as Array<T & { fusedScore: number }>
}

export function applyRerankerScores<T extends RankedMemoryCandidate>(
  candidates: readonly T[],
  scores: ReadonlyMap<string, number>,
): Array<T & { rerankerScore: number | null }> {
  return candidates
    .map((candidate) => ({
      ...candidate,
      rerankerScore: finiteScore(scores.get(candidate.id)),
    }))
    .sort(
      (left, right) =>
        (right.rerankerScore ?? Number.NEGATIVE_INFINITY) -
          (left.rerankerScore ?? Number.NEGATIVE_INFINITY) ||
        (right.fusedScore ?? 0) - (left.fusedScore ?? 0) ||
        left.id.localeCompare(right.id),
    ) as Array<T & { rerankerScore: number | null }>
}

export function decideMemoryAdmission(
  candidate: RankedMemoryCandidate | undefined,
  config: MemoryAdmissionConfig,
): MemoryAdmissionDecision {
  if (!config.enabled) return { admitted: true, reason: 'admission_disabled' }
  if (!candidate)
    return { admitted: false, reason: 'below_relevance_threshold' }
  if (candidate.rerankerScore != null)
    return candidate.rerankerScore >= config.minRerankerScore
      ? { admitted: true, reason: 'reranker_passed' }
      : { admitted: false, reason: 'below_relevance_threshold' }
  if (candidate.lexicalScore >= config.minLexicalScore)
    return { admitted: true, reason: 'strong_lexical_match' }
  if (candidate.vectorScore >= config.minVectorScore)
    return { admitted: true, reason: 'strong_vector_match' }
  if (
    config.requireSignalAgreement &&
    candidate.lexicalScore >= 0.15 &&
    candidate.vectorScore >= 0.5
  )
    return { admitted: true, reason: 'signal_agreement' }
  return { admitted: false, reason: 'below_relevance_threshold' }
}

function rankMap(
  candidates: readonly RankedMemoryCandidate[],
): Map<string, number> {
  return new Map(
    candidates.map((candidate, index) => [candidate.id, index + 1]),
  )
}

function scoreOrder(key: 'lexicalScore' | 'vectorScore') {
  return (left: RankedMemoryCandidate, right: RankedMemoryCandidate) =>
    right[key] - left[key] || left.id.localeCompare(right.id)
}

function finiteScore(value: number | undefined): number | null {
  return Number.isFinite(value) ? Number(value) : null
}
