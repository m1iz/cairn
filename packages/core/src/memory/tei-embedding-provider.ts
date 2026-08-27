import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingRequestOptions,
} from './hybrid-retrieval'

export interface TeiEmbeddingProviderOptions {
  endpoint: string
  model: string
  dimensions: number
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

/**
 * Adapter for Hugging Face Text Embeddings Inference. E5 models require
 * asymmetric query/passage prefixes, so the caller declares the purpose.
 */
export class TeiEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id: string
  readonly dimensions: number
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(opts: TeiEmbeddingProviderOptions) {
    this.endpoint = String(opts.endpoint).replace(/\/+$/, '')
    this.dimensions = Math.max(1, Math.trunc(opts.dimensions))
    this.timeoutMs = Math.max(100, Math.trunc(opts.timeoutMs ?? 10_000))
    this.fetchImpl = opts.fetch ?? globalThis.fetch
    this.id = `tei:${String(opts.model)}:${this.dimensions}`
    if (!this.endpoint) throw new Error('TEI endpoint is required')
  }

  async embed(
    texts: readonly string[],
    opts: MemoryEmbeddingRequestOptions = {},
  ): Promise<number[][]> {
    if (!texts.length) return []
    const prefix = opts.purpose === 'query' ? 'query: ' : 'passage: '
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeout])
      : timeout
    const response = await this.fetchImpl(`${this.endpoint}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inputs: texts.map((text) => `${prefix}${String(text)}`),
      }),
      signal,
    })
    if (!response.ok)
      throw new Error(
        `TEI embedding request failed with HTTP ${response.status}`,
      )
    const payload: unknown = await response.json()
    if (!Array.isArray(payload))
      throw new Error('TEI returned a non-array payload')
    return payload.map((item, index) => {
      if (
        !Array.isArray(item) ||
        item.length !== this.dimensions ||
        item.some((value) => !Number.isFinite(Number(value)))
      )
        throw new Error(`TEI returned an invalid vector at index ${index}`)
      return item.map(Number)
    })
  }
}
