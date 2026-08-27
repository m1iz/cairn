import { describe, expect, it, vi } from 'vitest'
import { TeiEmbeddingProvider } from './tei-embedding-provider'

describe('TeiEmbeddingProvider', () => {
  it('uses E5 query and passage prefixes without leaking endpoint details into its id', async () => {
    const requests: unknown[] = []
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)))
        return new Response(
          JSON.stringify([
            [1, 0],
            [0, 1],
          ]),
          { status: 200 },
        )
      },
    )
    const provider = new TeiEmbeddingProvider({
      endpoint: 'http://127.0.0.1:8088/',
      model: 'fixture-e5',
      dimensions: 2,
      fetch,
    })

    await provider.embed(['数据库在哪里', 'cache host'], {
      purpose: 'query',
    })
    await provider.embed(['数据库位于本机'], { purpose: 'document' })

    expect(provider.id).toBe('tei:fixture-e5:2')
    expect(requests).toEqual([
      { inputs: ['query: 数据库在哪里', 'query: cache host'] },
      { inputs: ['passage: 数据库位于本机'] },
    ])
  })

  it('rejects malformed vectors', async () => {
    const provider = new TeiEmbeddingProvider({
      endpoint: 'http://127.0.0.1:8088',
      model: 'fixture-e5',
      dimensions: 2,
      fetch: vi.fn(
        async () => new Response(JSON.stringify([[1]]), { status: 200 }),
      ),
    })

    await expect(provider.embed(['text'])).rejects.toThrow('invalid vector')
  })
})
