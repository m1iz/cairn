import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import fixture from './fixtures/hybrid-memory-eval-v2.json'
import {
  decideHybridMemoryGate,
  evaluateHybridMemory,
  type MemoryEvaluationCase,
  type MemoryEvaluationRetriever,
} from './hybrid-eval'
import {
  HybridMemoryRetriever,
  type HybridMemoryChunkInput,
  type HybridMemorySearchScope,
} from './hybrid-retrieval'
import { PostgresHybridMemoryVectorStore } from './postgres-vector-store'
import { TeiEmbeddingProvider } from './tei-embedding-provider'

const enabled = process.env.CAIRN_MEMORY_INTEGRATION === '1'
const connectionString = process.env.CAIRN_MEMORY_DATABASE_URL ?? ''

describe.runIf(enabled && Boolean(connectionString))(
  'Cairn real bilingual hybrid-memory evaluation',
  () => {
    it('evaluates 30 fixed cases and emits a provider-bound receipt', async () => {
      const now = Date.parse(fixture.now)
      const chunks = fixture.chunks.map((item) => ({
        ...item,
        source: item.source as HybridMemoryChunkInput['source'],
        createdAt: now - Number(item.ageDays ?? 0) * 86_400_000,
      }))
      const cases = fixture.cases.map((item) => ({
        id: item.id,
        kind: item.kind as MemoryEvaluationCase['kind'],
        query: item.query,
        expectedIds: item.expectedIds,
        staleIds: 'staleIds' in item ? item.staleIds : [],
        forbiddenIds: 'forbiddenIds' in item ? item.forbiddenIds : [],
      }))
      const scopes = Object.fromEntries(
        fixture.cases.map((item) => [
          item.id,
          item.scope as HybridMemorySearchScope,
        ]),
      )
      const provider = new TeiEmbeddingProvider({
        endpoint: process.env.CAIRN_MEMORY_TEI_URL ?? 'http://127.0.0.1:8088',
        model: 'intfloat/multilingual-e5-small',
        dimensions: 384,
        timeoutMs: 30_000,
      })
      const store = new PostgresHybridMemoryVectorStore({ connectionString })
      try {
        const engine = new HybridMemoryRetriever({
          embeddingProvider: provider,
          vectorStore: store,
          now: () => now,
          config: { temporalHalfLifeDays: 14 },
        })
        await engine.replace(chunks)
        const candidate: MemoryEvaluationRetriever = {
          id: `hybrid-v2:${provider.id}`,
          fallbackVerified: await verifyFallback(now),
          derivedDiskBytes: Buffer.byteLength(JSON.stringify(chunks)),
          async retrieve(input) {
            const response = await engine.search({
              query: input.query,
              scope: scopes[input.caseId]!,
              maxResults: input.maxResults,
            })
            return response.results.map((item) => item.id)
          },
        }
        const report = await evaluateHybridMemory({
          datasetId: fixture.datasetId,
          cases,
          baseline: naiveUnscopedLexicalBaseline(chunks),
          candidate,
          maxResults: 4,
        })
        const decision = decideHybridMemoryGate(report)
        const outputPath = process.env.CAIRN_MEMORY_EVAL_REPORT
        if (outputPath) {
          await mkdir(dirname(outputPath), { recursive: true })
          await writeFile(
            outputPath,
            `${JSON.stringify({ report, decision }, null, 2)}\n`,
            'utf8',
          )
          if (decision.passed) {
            const receiptPath = process.env.CAIRN_MEMORY_EVAL_RECEIPT
            if (receiptPath) {
              await mkdir(dirname(receiptPath), { recursive: true })
              await writeFile(
                receiptPath,
                `${JSON.stringify(
                  {
                    passed: true,
                    datasetSha256: report.datasetSha256,
                    embeddingProviderId: provider.id,
                  },
                  null,
                  2,
                )}\n`,
                'utf8',
              )
            }
          }
        }

        expect(report.caseCount).toBe(30)
        expect(report.candidate.crossProjectPollutionRate).toBe(0)
        expect(report.candidate.fallbackVerified).toBe(true)
        expect(decision).toEqual({ passed: true, reasons: [] })
      } finally {
        await store.close()
      }
    }, 120_000)
  },
)

function naiveUnscopedLexicalBaseline(
  chunks: readonly HybridMemoryChunkInput[],
): MemoryEvaluationRetriever {
  return {
    id: 'naive-unscoped-token-overlap',
    fallbackVerified: true,
    derivedDiskBytes: 0,
    async retrieve(input) {
      const query = new Set(tokens(input.query))
      return chunks
        .map((chunk, index) => ({
          id: chunk.id,
          index,
          score: tokens(chunk.text).filter((token) => query.has(token)).length,
        }))
        .filter((item) => item.score > 0)
        .sort(
          (left, right) => right.score - left.score || left.index - right.index,
        )
        .slice(0, input.maxResults)
        .map((item) => item.id)
    },
  }
}

async function verifyFallback(now: number): Promise<boolean> {
  const engine = new HybridMemoryRetriever({
    embeddingProvider: {
      id: 'forced-outage',
      dimensions: 2,
      async embed() {
        throw new Error('forced evaluation outage')
      },
    },
    now: () => now,
  })
  await engine.replace([
    {
      id: 'fallback-eval',
      text: '精确回退标记 FALLBACK-EVAL-8821',
      source: 'global',
      path: 'MEMORY.md',
      createdAt: now,
    },
  ])
  const response = await engine.search({
    query: 'FALLBACK-EVAL-8821',
    scope: { mode: 'chat' },
  })
  return (
    response.strategy === 'fts_fallback' &&
    response.results[0]?.id === 'fallback-eval'
  )
}

function tokens(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}_]+/gu) ?? []
  )
}
