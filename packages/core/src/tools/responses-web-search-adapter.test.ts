import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import type { LLMProvider } from '../providers/base'
import { ResponsesWebSearchAdapter } from './responses-web-search-adapter'

afterEach(() => {
  vi.useRealTimers()
})

describe('ResponsesWebSearchAdapter', () => {
  it('forces hosted search and maps strict structured output', async () => {
    const fetchImpl = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> =>
        providerResponse([
          {
            title: 'DeepSeek Responses API',
            url: 'https://api-docs.deepseek.com/guides/responses_api/',
            snippet: 'Official Responses API documentation.',
            published_at: '2026-08-01',
          },
        ]),
    )
    const adapter = new ResponsesWebSearchAdapter(() => deepseekRoute(), {
      fetchImpl: fetchImpl as typeof fetch,
    })

    await expect(
      adapter.search('DeepSeek Responses API', {
        maxResults: 3,
        fresh: true,
      }),
    ).resolves.toEqual([
      {
        title: 'DeepSeek Responses API',
        url: 'https://api-docs.deepseek.com/guides/responses_api/',
        snippet: 'Official Responses API documentation.',
        source: 'api-docs.deepseek.com',
        timestamp: '2026-08-01',
      },
    ])

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/responses')
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer deepseek-secret',
      'content-type': 'application/json',
      'x-client': 'cairn-test',
    })
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      input: 'DeepSeek Responses API',
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' },
      reasoning: { effort: 'low' },
      stream: false,
    })
    expect(body.instructions).toContain('last 30 days')
    expect(body.text.format.schema.properties.results.maxItems).toBe(3)
  })

  it('resolves the active route for every search', async () => {
    let model = 'deepseek-v4-flash'
    const fetchImpl = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => providerResponse([]),
    )
    const adapter = new ResponsesWebSearchAdapter(
      () => deepseekRoute({ model }),
      { fetchImpl: fetchImpl as typeof fetch },
    )

    await adapter.search('first', { maxResults: 1 })
    model = 'deepseek-v4-pro'
    await adapter.search('second', { maxResults: 1 })

    expect(
      fetchImpl.mock.calls.map(
        (call) => JSON.parse(String(call[1]?.body)).model,
      ),
    ).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  })

  it('refuses unavailable capabilities, protocols, and credentials locally', async () => {
    const fetchImpl = vi.fn()
    const withoutCapability = new ResponsesWebSearchAdapter(
      () => deepseekRoute({ hostedWebSearch: null }),
      { fetchImpl: fetchImpl as typeof fetch },
    )
    await expect(
      withoutCapability.search('query', { maxResults: 5 }),
    ).rejects.toThrow('not available for provider deepseek')

    const wrongProtocol = new ResponsesWebSearchAdapter(
      () => deepseekRoute({ protocol: 'anthropic' }),
      { fetchImpl: fetchImpl as typeof fetch },
    )
    await expect(
      wrongProtocol.search('query', { maxResults: 5 }),
    ).rejects.toThrow('requires the openai provider protocol')

    const withoutCredential = new ResponsesWebSearchAdapter(
      () => deepseekRoute({ apiKey: null }),
      { fetchImpl: fetchImpl as typeof fetch },
    )
    await expect(
      withoutCredential.search('query', { maxResults: 5 }),
    ).rejects.toThrow('credential is missing')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('filters invalid URLs and rejects malformed provider output', async () => {
    const filtered = new ResponsesWebSearchAdapter(() => deepseekRoute(), {
      fetchImpl: vi.fn(async () =>
        providerResponse([
          {
            title: 'Unsafe',
            url: 'file:///secret',
            snippet: 'unsafe',
            published_at: '',
          },
          {
            title: 'Safe',
            url: 'https://example.com/result',
            snippet: 'safe',
            published_at: '',
          },
        ]),
      ) as typeof fetch,
    })
    await expect(filtered.search('query', { maxResults: 5 })).resolves.toEqual([
      expect.objectContaining({
        title: 'Safe',
        url: 'https://example.com/result',
      }),
    ])

    const malformed = new ResponsesWebSearchAdapter(() => deepseekRoute(), {
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'completed', output: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ) as typeof fetch,
    })
    await expect(malformed.search('query', { maxResults: 5 })).rejects.toThrow(
      'without a search action',
    )
  })

  it('accepts the multi-message fenced output returned by DeepSeek search', async () => {
    const finalText = `Here are the grounded results:\n\n\`\`\`json
{"results":[{"title":"Official docs","url":"https://api-docs.deepseek.com/api/create-response/","snippet":"Responses API","published_at":null}]}
\`\`\`\n\nSummary follows.`
    const adapter = new ResponsesWebSearchAdapter(() => deepseekRoute(), {
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: 'Searching official sources.',
                    },
                  ],
                },
                { type: 'web_search_call', status: 'completed', action: {} },
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: finalText }],
                },
              ],
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    })

    await expect(adapter.search('query', { maxResults: 3 })).resolves.toEqual([
      {
        title: 'Official docs',
        url: 'https://api-docs.deepseek.com/api/create-response/',
        snippet: 'Responses API',
        source: 'api-docs.deepseek.com',
        timestamp: '',
      },
    ])
  })

  it('maps safe HTTP errors without exposing credentials or response bodies', async () => {
    const adapter = new ResponsesWebSearchAdapter(() => deepseekRoute(), {
      fetchImpl: vi.fn(
        async () =>
          new Response('deepseek-secret server detail', { status: 401 }),
      ) as typeof fetch,
    })

    await expect(adapter.search('query', { maxResults: 5 })).rejects.toThrow(
      'credential was rejected',
    )
    await expect(
      adapter.search('query', { maxResults: 5 }),
    ).rejects.not.toThrow(/deepseek-secret|server detail/)
  })

  it('honours timeout and caller cancellation', async () => {
    vi.useFakeTimers()
    const pendingFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          )
        }),
    )
    const adapter = new ResponsesWebSearchAdapter(() => deepseekRoute(), {
      fetchImpl: pendingFetch as typeof fetch,
      timeoutMs: 1_000,
    })

    const timedOut = adapter.search('query', { maxResults: 5 })
    const timeoutExpectation = expect(timedOut).rejects.toThrow(
      'timed out after 1000ms',
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await timeoutExpectation

    const caller = new AbortController()
    const cancelled = adapter.search('query', {
      maxResults: 5,
      signal: caller.signal,
    })
    const cancellationExpectation = expect(cancelled).rejects.toThrow(
      'Web search cancelled',
    )
    caller.abort()
    await cancellationExpectation
  })
})

function providerResponse(results: Array<Record<string, unknown>>): Response {
  return new Response(
    JSON.stringify({
      status: 'completed',
      output: [
        { type: 'web_search_call', status: 'completed', action: {} },
        {
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify({ results }) }],
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function deepseekRoute(
  overrides: {
    model?: string
    protocol?: 'openai' | 'anthropic'
    apiKey?: string | null
    hostedWebSearch?: ProviderSnapshot['hostedWebSearch']
  } = {},
): ModelRoute {
  const provider = {
    apiKey:
      overrides.apiKey === undefined ? 'deepseek-secret' : overrides.apiKey,
    extraHeaders: { 'x-client': 'cairn-test' },
  } as unknown as LLMProvider
  const snapshot = {
    provider,
    providerName: 'deepseek',
    providerLabel: 'DeepSeek',
    model: overrides.model ?? 'deepseek-v4-flash',
    apiBase: 'https://api.deepseek.com',
    protocol: overrides.protocol ?? 'openai',
    hostedWebSearch:
      overrides.hostedWebSearch === undefined
        ? {
            protocol: 'responses_web_search',
            toolType: 'web_search',
            requiredProtocol: 'openai',
          }
        : overrides.hostedWebSearch,
  } as ProviderSnapshot
  return {
    snapshot,
    useCase: 'web_search',
    reason: 'test',
    estimatedTokens: null,
  }
}
