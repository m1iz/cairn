import { describe, expect, it } from 'vitest'
import {
  applyRerankerScores,
  decideMemoryAdmission,
  reciprocalRankFusion,
  type RankedMemoryCandidate,
} from './hybrid-ranking'

const candidate = (
  id: string,
  lexicalScore: number,
  vectorScore: number,
): RankedMemoryCandidate => ({ id, text: id, lexicalScore, vectorScore })

describe('hybrid memory ranking', () => {
  it('uses ranks rather than incomparable raw score scales', () => {
    const ranked = reciprocalRankFusion([
      candidate('lexical', 100, 0),
      candidate('balanced', 2, 0.9),
      candidate('vector', 0, 0.99),
    ])
    expect(ranked[0]?.id).toBe('balanced')
    expect(ranked[0]).toMatchObject({ lexicalRank: 2, vectorRank: 2 })
  })

  it('allows a cross-encoder to reorder only the bounded pool', () => {
    const ranked = applyRerankerScores(
      reciprocalRankFusion([candidate('a', 1, 1), candidate('b', 0.5, 0.5)]),
      new Map([
        ['a', 0.2],
        ['b', 0.9],
      ]),
    )
    expect(ranked.map((item) => item.id)).toEqual(['b', 'a'])
  })

  it('returns no-memory when every relevance signal is weak', () => {
    expect(
      decideMemoryAdmission(candidate('noise', 0, 0.31), {
        enabled: true,
        minRerankerScore: 0.5,
        minLexicalScore: 0.65,
        minVectorScore: 0.8,
        requireSignalAgreement: true,
      }),
    ).toEqual({ admitted: false, reason: 'below_relevance_threshold' })
  })

  it('does not let weaker fallback signals override a reranker rejection', () => {
    expect(
      decideMemoryAdmission(
        { ...candidate('misleading-keyword', 1, 0.9), rerankerScore: 0.1 },
        {
          enabled: true,
          minRerankerScore: 0.5,
          minLexicalScore: 0.65,
          minVectorScore: 0.8,
          requireSignalAgreement: true,
        },
      ).admitted,
    ).toBe(false)
  })
})
