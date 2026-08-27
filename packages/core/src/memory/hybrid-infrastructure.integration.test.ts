import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { AgentLoop } from '../agent/loop'
import {
  HybridMemoryRetriever,
  type HybridMemoryChunkInput,
} from './hybrid-retrieval'
import { PostgresHybridMemoryVectorStore } from './postgres-vector-store'
import { TeiEmbeddingProvider } from './tei-embedding-provider'

const enabled = process.env.CAIRN_MEMORY_INTEGRATION === '1'
const connectionString = process.env.CAIRN_MEMORY_DATABASE_URL ?? ''

describe.runIf(enabled && Boolean(connectionString))(
  'hybrid memory local infrastructure',
  () => {
    it('persists E5 embeddings, reuses them, and preserves project isolation', async () => {
      const baseProvider = new TeiEmbeddingProvider({
        endpoint: process.env.CAIRN_MEMORY_TEI_URL ?? 'http://127.0.0.1:8088',
        model: 'integration-multilingual-e5-small',
        dimensions: 384,
        timeoutMs: 20_000,
      })
      let embeddedDocuments = 0
      const providerId = `integration-e5-${Date.now()}`
      const provider = {
        id: providerId,
        dimensions: baseProvider.dimensions,
        async embed(
          texts: readonly string[],
          options?: Parameters<TeiEmbeddingProvider['embed']>[1],
        ) {
          if (options?.purpose === 'document') embeddedDocuments += texts.length
          return baseProvider.embed(texts, options)
        },
      }
      const store = new PostgresHybridMemoryVectorStore({ connectionString })
      const inspectionPool = new Pool({ connectionString })
      const chunks: HybridMemoryChunkInput[] = [
        {
          id: 'integration-alpha-db',
          text: 'Cairn 的向量数据库监听本机 54329 端口。',
          source: 'project',
          path: 'alpha/MEMORY.md',
          projectId: 'integration-alpha',
          createdAt: Date.now(),
        },
        {
          id: 'integration-beta-db',
          text: '另一个项目的数据库监听 15432 端口。',
          source: 'project',
          path: 'beta/MEMORY.md',
          projectId: 'integration-beta',
          createdAt: Date.now(),
        },
      ]
      try {
        const first = new HybridMemoryRetriever({
          embeddingProvider: provider,
          vectorStore: store,
        })
        await first.replace(chunks)
        expect(embeddedDocuments).toBe(2)

        embeddedDocuments = 0
        const restarted = new HybridMemoryRetriever({
          embeddingProvider: provider,
          vectorStore: store,
        })
        await restarted.replace(chunks)
        expect(embeddedDocuments).toBe(0)
        const result = await restarted.search({
          query: 'Cairn 的向量数据服务使用哪个端口？',
          scope: { mode: 'build', projectId: 'integration-alpha' },
          maxResults: 2,
        })

        expect(result.strategy).toBe('hybrid')
        expect(result.results[0]?.id).toBe('integration-alpha-db')
        expect(result.results.map((item) => item.id)).not.toContain(
          'integration-beta-db',
        )
        const afterFirstHit = await inspectionPool.query<{
          chunk_id: string
          access_count: number
        }>(
          `SELECT chunk_id, access_count
             FROM memory_chunks
            WHERE embedding_provider = $1
            ORDER BY chunk_id`,
          [providerId],
        )
        expect(
          Object.fromEntries(
            afterFirstHit.rows.map((row) => [
              row.chunk_id,
              Number(row.access_count),
            ]),
          ),
        ).toEqual({
          'integration-alpha-db': 1,
          'integration-beta-db': 0,
        })

        await restarted.replace(chunks)
        const afterResync = await inspectionPool.query<{
          access_count: number
        }>(
          `SELECT access_count
             FROM memory_chunks
            WHERE embedding_provider = $1 AND chunk_id = $2`,
          [providerId, 'integration-alpha-db'],
        )
        expect(Number(afterResync.rows[0]?.access_count)).toBe(1)
        expect(store.diagnostics()).toMatchObject({ available: true })
      } finally {
        await store.close()
        await inspectionPool
          .query('DELETE FROM memory_chunks WHERE embedding_provider = $1', [
            providerId,
          ])
          .catch(() => {})
        await inspectionPool.end()
      }
    }, 60_000)

    it('assembles the provider, vector store, and evaluation receipt from local config', async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), 'cairn-memory-config-'))
      await writeFile(
        join(stateRoot, 'cairn.local.json'),
        JSON.stringify({
          memory: {
            hybridMemory: 'on',
            embedding: {
              provider: 'tei',
              endpoint:
                process.env.CAIRN_MEMORY_TEI_URL ?? 'http://127.0.0.1:8088',
              model: 'intfloat/multilingual-e5-small',
              dimensions: 384,
              timeoutMs: 10_000,
            },
            vectorDatabase: {
              provider: 'postgres',
              connectionString,
            },
            evaluationReceiptPath: process.env.CAIRN_MEMORY_EVAL_RECEIPT,
          },
        }),
        'utf8',
      )
      const loop = await AgentLoop.create({
        root: process.cwd(),
        stateRoot,
        initializeMcp: false,
      })
      try {
        expect(loop.hybridMemory.diagnostics()).toMatchObject({
          capability: {
            requestedMode: 'on',
            effectiveMode: 'on',
            promptMutationAllowed: true,
            embeddingProviderId: 'tei:intfloat/multilingual-e5-small:384',
          },
          vectorStore: { id: 'postgres-pgvector' },
        })
        const retrieval = await loop.hybridMemory.retrieve({
          query: 'Where is the local memory database listening?',
          documents: [
            {
              id: 'assembly-memory',
              content:
                '## Storage\n\nThe local memory database listens on port 54329.',
              source: 'global',
              path: 'MEMORY.local.md',
              createdAt: Date.now(),
            },
          ],
          scope: { mode: 'chat', sessionId: 'assembly-session' },
        })
        expect(retrieval.search?.strategy).toBe('hybrid')
        expect(retrieval.promptProjection).toContain('54329')
      } finally {
        await loop.close()
      }
    }, 60_000)
  },
)
