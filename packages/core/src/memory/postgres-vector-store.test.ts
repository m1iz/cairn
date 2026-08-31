import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { PostgresHybridMemoryVectorStore } from './postgres-vector-store'

describe('PostgresHybridMemoryVectorStore scope SQL', () => {
  it('requires exact project and session identity for Build session candidates', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = []
    const pool = fakePool(queries)
    const store = new PostgresHybridMemoryVectorStore({
      connectionString: 'postgres://unused',
      pool,
    })

    await store.search(
      [1, 0],
      {
        mode: 'build',
        projectId: 'project-one',
        sessionId: 'session-one',
      },
      6,
      provider,
    )

    const query = queries.at(-1)!
    expect(query.text).toContain(
      "source = 'session' AND project_id = $3 AND session_id = $4",
    )
    expect(query.text).toContain('LIMIT $5')
    expect(query.values).toEqual([
      '[1,0]',
      provider.id,
      'project-one',
      'session-one',
      6,
    ])
  })

  it('does not admit unscoped session rows in Chat', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = []
    const store = new PostgresHybridMemoryVectorStore({
      connectionString: 'postgres://unused',
      pool: fakePool(queries),
    })

    await store.search(
      [1, 0],
      { mode: 'chat', sessionId: 'session-chat' },
      4,
      provider,
    )

    const query = queries.at(-1)!
    expect(query.text).toContain("source = 'global'")
    expect(query.text).toContain('session_id = $3')
    expect(query.text).not.toContain('session_id IS NULL')
    expect(query.text).toContain('LIMIT $4')
    expect(query.values).toEqual(['[1,0]', provider.id, 'session-chat', 4])
  })
})

const provider = {
  id: 'test-provider',
  dimensions: 2,
  async embed() {
    return [[1, 0]]
  },
}

function fakePool(queries: Array<{ text: string; values: unknown[] }>): Pool {
  return {
    on() {
      return this
    },
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values })
      return { rows: [], rowCount: 0 }
    },
    async end() {},
  } as unknown as Pool
}
