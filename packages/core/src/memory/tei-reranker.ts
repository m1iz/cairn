import type { MemoryReranker, RankedMemoryCandidate } from './hybrid-ranking'

export interface TeiRerankerOptions {
  endpoint: string
  model?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Local TEI cross-encoder adapter. Failure is handled by the retriever. */
export class TeiMemoryReranker implements MemoryReranker {
  readonly id: string
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: TeiRerankerOptions) {
    this.endpoint = String(options.endpoint).replace(/\/+$/, '')
    this.id = options.model ?? 'BAAI/bge-reranker-v2-m3'
    this.timeoutMs = Math.max(100, Math.trunc(options.timeoutMs ?? 800))
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async rerank(
    query: string,
    candidates: readonly RankedMemoryCandidate[],
    options: { signal?: AbortSignal; topN?: number } = {},
  ): Promise<Map<string, number>> {
    if (!candidates.length) return new Map()
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout
    const response = await this.fetchImpl(`${this.endpoint}/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: String(query),
        texts: candidates.map((candidate) => candidate.text),
        truncate: true,
        raw_scores: false,
        return_text: false,
      }),
      signal,
    })
    if (!response.ok)
      throw new Error(`TEI reranker returned HTTP ${response.status}`)
    const payload = (await response.json()) as Array<{
      index?: number
      score?: number
    }>
    const scores = new Map<string, number>()
    for (const row of payload) {
      const index = Math.trunc(Number(row.index))
      const score = Number(row.score)
      const candidate = candidates[index]
      if (candidate && Number.isFinite(score)) scores.set(candidate.id, score)
    }
    return scores
  }
}
