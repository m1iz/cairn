import type { ModelRoute } from '../model/router'
import type { WebSearchAdapter, WebSearchResult } from './web-search'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

type FetchLike = typeof fetch

export interface ResponsesWebSearchAdapterOptions {
  fetchImpl?: FetchLike
  timeoutMs?: number
}

/**
 * Routes the existing local web_search tool through a provider-hosted
 * Responses API search without changing the main Chat Completions loop.
 */
export class ResponsesWebSearchAdapter implements WebSearchAdapter {
  readonly name = 'provider_responses_web_search'

  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(
    private readonly route: () => ModelRoute,
    opts: ResponsesWebSearchAdapterOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = boundedTimeout(opts.timeoutMs)
  }

  async search(
    query: string,
    opts: { maxResults: number; fresh?: boolean; signal?: AbortSignal | null },
  ): Promise<WebSearchResult[]> {
    const snapshot = this.route().snapshot
    const capability = snapshot.hostedWebSearch
    if (!capability)
      throw new Error(
        `Web search is not available for provider ${safeLabel(snapshot.providerName)}`,
      )
    if (capability.protocol !== 'responses_web_search')
      throw new Error(
        'The active provider uses an unsupported web search protocol',
      )
    if (snapshot.protocol !== capability.requiredProtocol)
      throw new Error(
        `Web search requires the ${capability.requiredProtocol} provider protocol`,
      )
    const apiKey = snapshot.provider.apiKey?.trim()
    if (!apiKey) throw new Error('The active provider credential is missing')
    if (!snapshot.apiBase)
      throw new Error('The active provider API base is missing')

    const request = cancellableRequest(opts.signal, this.timeoutMs)
    try {
      const response = await this.fetchImpl(
        responsesEndpoint(snapshot.apiBase),
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            ...snapshot.provider.extraHeaders,
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(
            responsesSearchBody({
              model: snapshot.model,
              query,
              maxResults: opts.maxResults,
              fresh: opts.fresh === true,
              toolType: capability.toolType,
            }),
          ),
          signal: request.signal,
        },
      )
      if (!response.ok) throw providerHttpError(response.status)
      const declaredBytes = Number(response.headers.get('content-length') ?? 0)
      if (declaredBytes > MAX_RESPONSE_BYTES)
        throw new Error('Web search response exceeded the size limit')
      const raw = await response.text()
      if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES)
        throw new Error('Web search response exceeded the size limit')
      return parseResponsesSearchPayload(raw, opts.maxResults)
    } catch (error) {
      if (request.timedOut())
        throw new Error(`Web search timed out after ${this.timeoutMs}ms`)
      if (opts.signal?.aborted) throw new Error('Web search cancelled')
      if (error instanceof Error) throw error
      throw new Error('Provider web search failed')
    } finally {
      request.close()
    }
  }
}

function responsesSearchBody(input: {
  model: string
  query: string
  maxResults: number
  fresh: boolean
  toolType: 'web_search' | 'web_search_2025_08_26'
}): Record<string, unknown> {
  const recency = input.fresh
    ? 'Prioritize sources published or updated within the last 30 days.'
    : 'Use the most authoritative and relevant sources.'
  return {
    model: input.model,
    instructions:
      'Perform web research for the supplied query. Return only results grounded in pages actually found by web search. Never invent, repair, or guess a URL. ' +
      recency,
    input: input.query,
    tools: [{ type: input.toolType }],
    tool_choice: { type: input.toolType },
    reasoning: { effort: 'low' },
    max_output_tokens: 4_000,
    text: {
      format: {
        type: 'json_schema',
        name: 'web_search_results',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            results: {
              type: 'array',
              maxItems: input.maxResults,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title: { type: 'string', maxLength: 240 },
                  url: { type: 'string', maxLength: 2_048 },
                  snippet: { type: 'string', maxLength: 800 },
                  published_at: { type: 'string', maxLength: 80 },
                },
                required: ['title', 'url', 'snippet', 'published_at'],
              },
            },
          },
          required: ['results'],
        },
      },
    },
    stream: false,
  }
}

function parseResponsesSearchPayload(
  raw: string,
  maxResults: number,
): WebSearchResult[] {
  let response: unknown
  try {
    response = JSON.parse(raw)
  } catch {
    throw new Error('Provider web search returned invalid JSON')
  }
  if (!isRecord(response) || response.status === 'failed')
    throw new Error('Provider web search failed')
  if (!completedWebSearch(response))
    throw new Error('Provider web search completed without a search action')
  const payload = structuredOutput(response)
  if (!isRecord(payload) || !Array.isArray(payload.results))
    throw new Error('Provider web search returned an invalid result shape')
  return payload.results
    .filter(isRecord)
    .map((result) => normalizedSearchResult(result))
    .filter((result) => result.url.length > 0)
    .slice(0, Math.max(1, Math.min(10, Math.trunc(maxResults))))
}

function structuredOutput(response: Record<string, unknown>): unknown {
  const texts = outputTexts(response)
  for (const text of texts.reverse()) {
    for (const candidate of jsonCandidates(text)) {
      try {
        return JSON.parse(candidate)
      } catch {
        // DeepSeek may wrap otherwise valid structured output in prose or a fence.
      }
    }
  }
  throw new Error('Provider web search returned invalid structured output')
}

function outputTexts(response: Record<string, unknown>): string[] {
  const parts: string[] = []
  if (typeof response.output_text === 'string') parts.push(response.output_text)
  if (!Array.isArray(response.output)) return parts
  for (const item of response.output) {
    if (
      !isRecord(item) ||
      item.type !== 'message' ||
      !Array.isArray(item.content)
    )
      continue
    for (const content of item.content) {
      if (
        isRecord(content) &&
        content.type === 'output_text' &&
        typeof content.text === 'string'
      )
        parts.push(content.text)
    }
  }
  if (!parts.length) throw new Error('Provider web search returned no text')
  return parts
}

function completedWebSearch(response: Record<string, unknown>): boolean {
  return (
    Array.isArray(response.output) &&
    response.output.some(
      (item) =>
        isRecord(item) &&
        item.type === 'web_search_call' &&
        item.status === 'completed',
    )
  )
}

function jsonCandidates(text: string): string[] {
  const candidates = [text.trim()]
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1].trim())
  }
  const embedded = firstJsonObject(text)
  if (embedded) candidates.push(embedded)
  return [...new Set(candidates.filter(Boolean))]
}

function firstJsonObject(text: string): string | null {
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (start < 0) {
      if (char !== '{') continue
      start = index
      depth = 1
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (quoted && char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) return text.slice(start, index + 1)
  }
  return null
}

function normalizedSearchResult(
  result: Record<string, unknown>,
): WebSearchResult {
  const url = safeHttpUrl(stringValue(result.url))
  return {
    title: stringValue(result.title),
    url,
    snippet: stringValue(result.snippet),
    source: url ? new URL(url).hostname : '',
    timestamp: stringValue(result.published_at),
  }
}

function responsesEndpoint(apiBase: string): string {
  const base = apiBase.trim().replace(/\/+$/, '')
  return base.toLowerCase().endsWith('/responses') ? base : `${base}/responses`
}

function providerHttpError(status: number): Error {
  if (status === 400)
    return new Error('The active provider or model rejected web search')
  if (status === 401 || status === 403)
    return new Error('The active provider credential was rejected')
  if (status === 429)
    return new Error('The provider web search rate limit was reached')
  return new Error(`Provider web search failed with HTTP ${status}`)
}

function cancellableRequest(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal
  timedOut: () => boolean
  close: () => void
} {
  const controller = new AbortController()
  let didTimeout = false
  const cancelFromCaller = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) cancelFromCaller()
  else callerSignal?.addEventListener('abort', cancelFromCaller, { once: true })
  const timer = setTimeout(() => {
    didTimeout = true
    controller.abort(new Error('web search timeout'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    close: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', cancelFromCaller)
    },
  }
}

function boundedTimeout(value: number | undefined): number {
  const timeout = Number(value ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(timeout)) return DEFAULT_TIMEOUT_MS
  return Math.max(1_000, Math.min(120_000, Math.trunc(timeout)))
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function safeLabel(value: unknown): string {
  return (
    stringValue(value)
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .slice(0, 80) || 'unknown'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
