import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  scoreLongMemEvalRankings,
  type LongMemEvalRanking,
  type LongMemEvalRetrievalMetrics,
} from './longmemeval-eval'
import {
  HybridMemoryRetriever,
  type HybridMemoryChunkInput,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingRequestOptions,
} from './hybrid-retrieval'
import { TeiEmbeddingProvider } from './tei-embedding-provider'

const enabled = process.env.CAIRN_LONGMEMEVAL === '1'
const dataPath = process.env.CAIRN_LONGMEMEVAL_DATA ?? ''
const databaseUrl = process.env.CAIRN_LONGMEMEVAL_DATABASE_URL ?? ''
const reportPath = process.env.CAIRN_LONGMEMEVAL_REPORT ?? ''
const EXPECTED_DATASET_SHA256 =
  'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442'
const MAX_CHARS = 1_800
const CHUNK_OVERLAP = 160
const RETRIEVED_CHUNKS = 50
const RETRIEVED_SESSIONS = 5
const EMBEDDING_CONCURRENCY = 4

interface LongMemEvalItem {
  question_id: string
  question_type: string
  question: string
  question_date: string
  answer: string
  answer_session_ids: string[]
  haystack_dates: string[]
  haystack_session_ids: string[]
  haystack_sessions: Array<Array<{ role: string; content: string }>>
}

type MethodId = 'bm25' | 'vector' | 'hybridFusion' | 'cairnHybrid'

interface CaseResult extends LongMemEvalRanking {
  questionId: string
  questionType: string
  retrievedSessionIds: string[]
}

describe.runIf(enabled && Boolean(dataPath) && Boolean(databaseUrl))(
  'LongMemEval-S full public retrieval benchmark',
  () => {
    it('evaluates all 500 cases without a chat-model API', async () => {
      const started = performance.now()
      const payload = await readFile(dataPath)
      const datasetSha256 = sha256(payload)
      if (datasetSha256 !== EXPECTED_DATASET_SHA256)
        throw new Error(`unexpected LongMemEval dataset hash: ${datasetSha256}`)
      const items = JSON.parse(payload.toString('utf8')) as LongMemEvalItem[]
      if (items.length !== 500)
        throw new Error(
          `expected 500 LongMemEval cases, received ${items.length}`,
        )

      const delegate = new TeiEmbeddingProvider({
        endpoint: process.env.CAIRN_MEMORY_TEI_URL ?? 'http://127.0.0.1:8088',
        model: 'intfloat/multilingual-e5-small',
        dimensions: 384,
        timeoutMs: 120_000,
      })
      const provider = new PostgresCachedEmbeddingProvider({
        delegate,
        connectionString: databaseUrl,
        batchSize: 64,
      })
      const results: Record<MethodId, CaseResult[]> = {
        bm25: [],
        vector: [],
        hybridFusion: [],
        cairnHybrid: [],
      }
      let indexedChunks = 0

      try {
        await provider.initialize()
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index]!
          validateItem(item)
          const chunks = chunksForItem(item)
          indexedChunks += chunks.length
          const now = parseLongMemEvalDate(item.question_date)
          const bm25 = new HybridMemoryRetriever({
            now: () => now,
            config: neutralRetrievalConfig({ textWeight: 1, vectorWeight: 0 }),
          })
          const vector = new HybridMemoryRetriever({
            embeddingProvider: provider,
            now: () => now,
            config: neutralRetrievalConfig({ textWeight: 0, vectorWeight: 1 }),
          })
          const hybridFusion = new HybridMemoryRetriever({
            embeddingProvider: provider,
            now: () => now,
            config: neutralRetrievalConfig({
              textWeight: 0.55,
              vectorWeight: 0.45,
            }),
          })
          const cairnHybrid = new HybridMemoryRetriever({
            embeddingProvider: provider,
            now: () => now,
          })

          await bm25.replace(chunks)
          await vector.replace(chunks)
          await hybridFusion.replace(chunks)
          await cairnHybrid.replace(chunks)
          results.bm25.push(await retrieveCase('bm25', bm25, item))
          results.vector.push(await retrieveCase('vector', vector, item))
          results.hybridFusion.push(
            await retrieveCase('hybridFusion', hybridFusion, item),
          )
          results.cairnHybrid.push(
            await retrieveCase('cairnHybrid', cairnHybrid, item),
          )

          if ((index + 1) % 10 === 0 || index + 1 === items.length) {
            console.log(
              `[LongMemEval] ${index + 1}/${items.length} cases; ` +
                `${provider.embeddedDocuments} passages embedded, ` +
                `${provider.cacheHits} cache hits`,
            )
            if (reportPath)
              await writeReport(reportPath, {
                status: 'running',
                datasetSha256,
                completedCases: index + 1,
                totalCases: items.length,
                indexedChunks,
                embeddingCache: provider.statistics(),
                elapsedMs: rounded(performance.now() - started),
              })
          }
        }

        const metrics = {
          bm25: metricsWithCategories(results.bm25),
          vector: metricsWithCategories(results.vector),
          hybridFusion: metricsWithCategories(results.hybridFusion),
          cairnHybrid: metricsWithCategories(results.cairnHybrid),
        }
        const report = {
          schemaVersion: 2,
          status: 'complete',
          benchmark: 'LongMemEval-S cleaned',
          datasetSha256,
          caseCount: items.length,
          questionTypeCounts: countQuestionTypes(items),
          configuration: {
            embeddingProvider: provider.id,
            chunkMaxChars: MAX_CHARS,
            chunkOverlapChars: CHUNK_OVERLAP,
            retrievedChunks: RETRIEVED_CHUNKS,
            evaluatedSessions: RETRIEVED_SESSIONS,
            candidatePool: 'per_question_haystack',
            baselineIsolation: {
              bm25: 'lexical_only',
              vector: 'vector_only_without_lexical_safety_floor',
              hybridFusion:
                'neutral_55_45_fusion_without_decay_source_boost_or_mmr',
              cairnHybrid: 'production_defaults',
            },
            chatModelApiCalls: 0,
          },
          indexedChunks,
          embeddingCache: provider.statistics(),
          metrics,
          lift: {
            hybridFusionVsBm25: metricLift(
              metrics.bm25.overall,
              metrics.hybridFusion.overall,
            ),
            hybridFusionVsVector: metricLift(
              metrics.vector.overall,
              metrics.hybridFusion.overall,
            ),
            cairnHybridVsVector: metricLift(
              metrics.vector.overall,
              metrics.cairnHybrid.overall,
            ),
          },
          elapsedMs: rounded(performance.now() - started),
        }
        if (reportPath) await writeReport(reportPath, report)

        expect(report.caseCount).toBe(500)
        expect(report.configuration.chatModelApiCalls).toBe(0)
        expect(report.metrics.hybridFusion.overall.caseCount).toBe(500)
        expect(report.metrics.cairnHybrid.overall.caseCount).toBe(500)
      } finally {
        await provider.close()
      }
    }, 43_200_000)
  },
)

async function retrieveCase(
  method: MethodId,
  retriever: HybridMemoryRetriever,
  item: LongMemEvalItem,
): Promise<CaseResult> {
  const started = performance.now()
  const response = await retriever.search({
    query: item.question,
    scope: { mode: 'chat', sessionId: item.question_id },
    maxResults: RETRIEVED_CHUNKS,
  })
  const latencyMs = performance.now() - started
  const retrievedSessionIds: string[] = []
  for (const chunk of response.results) {
    const sessionId = String(chunk.sessionId ?? '')
    if (sessionId && !retrievedSessionIds.includes(sessionId))
      retrievedSessionIds.push(sessionId)
    if (retrievedSessionIds.length >= RETRIEVED_SESSIONS) break
  }
  if (method === 'bm25' && response.strategy !== 'fts')
    throw new Error(`BM25 unexpectedly used ${response.strategy}`)
  return {
    questionId: item.question_id,
    questionType: item.question_type,
    expectedSessionIds: item.answer_session_ids,
    retrievedSessionIds,
    latencyMs,
  }
}

function chunksForItem(item: LongMemEvalItem): HybridMemoryChunkInput[] {
  const chunks: HybridMemoryChunkInput[] = []
  for (
    let sessionIndex = 0;
    sessionIndex < item.haystack_sessions.length;
    sessionIndex += 1
  ) {
    const sessionId = item.haystack_session_ids[sessionIndex]!
    const date = item.haystack_dates[sessionIndex]!
    const session = item.haystack_sessions[sessionIndex]!
    const text = [
      `Session date: ${date}`,
      ...session.map(
        (turn) => `${String(turn.role).toUpperCase()}: ${String(turn.content)}`,
      ),
    ].join('\n\n')
    const parts = splitWithOverlap(text, MAX_CHARS, CHUNK_OVERLAP)
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex]!
      chunks.push({
        id: sha256(`${sessionId}\0${partIndex}\0${part}`),
        text: part,
        source: 'global',
        path: `longmemeval/${sessionId}.md`,
        createdAt: parseLongMemEvalDate(date),
        sessionId,
      })
    }
  }
  return chunks
}

function splitWithOverlap(
  text: string,
  maxChars: number,
  overlap: number,
): string[] {
  if (text.length <= maxChars) return [text]
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars)
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf('\n\n', end),
        text.lastIndexOf(' ', end),
      )
      if (boundary > start + Math.trunc(maxChars * 0.6)) end = boundary
    }
    const part = text.slice(start, end).trim()
    if (part) parts.push(part)
    if (end >= text.length) break
    start = Math.max(start + 1, end - overlap)
  }
  return parts
}

function neutralRetrievalConfig(weights: {
  textWeight: number
  vectorWeight: number
}) {
  return {
    ...weights,
    fusionStrategy: 'weighted' as const,
    lexicalSafetyFloor: false,
    temporalHalfLifeDays: 1_000_000,
    sourceWeights: { global: 1, project: 1, session: 1 },
    mmr: { enabled: false, lambda: 1 },
  }
}

function metricsWithCategories(results: readonly CaseResult[]): {
  overall: LongMemEvalRetrievalMetrics
  byQuestionType: Record<string, LongMemEvalRetrievalMetrics>
} {
  const categories = new Map<string, CaseResult[]>()
  for (const result of results) {
    const bucket = categories.get(result.questionType) ?? []
    bucket.push(result)
    categories.set(result.questionType, bucket)
  }
  return {
    overall: scoreLongMemEvalRankings(results),
    byQuestionType: Object.fromEntries(
      [...categories.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, values]) => [key, scoreLongMemEvalRankings(values)]),
    ),
  }
}

function metricLift(
  baseline: LongMemEvalRetrievalMetrics,
  candidate: LongMemEvalRetrievalMetrics,
) {
  return Object.fromEntries(
    (
      [
        'hitAt1',
        'hitAt3',
        'hitAt5',
        'recallAt1',
        'recallAt3',
        'recallAt5',
        'mrrAt5',
        'ndcgAt5',
      ] as const
    ).map((key) => [
      key,
      {
        absolutePercentagePoints: rounded(
          (candidate[key] - baseline[key]) * 100,
        ),
        relativePercent: baseline[key]
          ? rounded(((candidate[key] - baseline[key]) / baseline[key]) * 100)
          : null,
      },
    ]),
  )
}

class PostgresCachedEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id: string
  readonly dimensions: number
  embeddedDocuments = 0
  cacheHits = 0
  private readonly delegate: MemoryEmbeddingProvider
  private readonly pool: Pool
  private readonly batchSize: number
  private recentDocuments = new Map<string, number[]>()
  private poolErrors = 0

  constructor(opts: {
    delegate: MemoryEmbeddingProvider
    connectionString: string
    batchSize: number
  }) {
    this.delegate = opts.delegate
    this.id = opts.delegate.id
    this.dimensions = opts.delegate.dimensions
    this.batchSize = Math.min(64, Math.max(1, Math.trunc(opts.batchSize)))
    this.pool = new Pool({
      connectionString: opts.connectionString,
      max: 1,
      idleTimeoutMillis: 0,
      application_name: 'cairn-longmemeval',
    })
    this.pool.on('error', (error) => {
      this.poolErrors += 1
      console.warn(`[LongMemEval] embedding cache connection: ${error.message}`)
    })
  }

  async initialize(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS embedding_cache (
      provider_id text NOT NULL,
      content_hash char(64) NOT NULL,
      embedding jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (provider_id, content_hash)
    )`)
  }

  async embed(
    texts: readonly string[],
    options: MemoryEmbeddingRequestOptions = {},
  ): Promise<number[][]> {
    if (options.purpose === 'query') return this.delegate.embed(texts, options)
    const hashes = texts.map((text) => sha256(String(text)))
    const vectors = new Map<string, number[]>()
    for (const hash of hashes) {
      const recent = this.recentDocuments.get(hash)
      if (recent) vectors.set(hash, recent)
    }
    const unresolved = [...new Set(hashes.filter((hash) => !vectors.has(hash)))]
    if (unresolved.length) {
      const cached = await this.pool.query<{
        content_hash: string
        embedding: number[]
      }>(
        `SELECT content_hash, embedding
           FROM embedding_cache
          WHERE provider_id = $1 AND content_hash = ANY($2::text[])`,
        [this.id, unresolved],
      )
      for (const row of cached.rows) {
        const vector = Array.isArray(row.embedding)
          ? row.embedding.map(Number)
          : []
        if (vector.length === this.dimensions)
          vectors.set(row.content_hash, vector)
      }
    }
    this.cacheHits += hashes.filter((hash) => vectors.has(hash)).length

    const missingByHash = new Map<string, string>()
    texts.forEach((text, index) => {
      const hash = hashes[index]!
      if (!vectors.has(hash) && !missingByHash.has(hash))
        missingByHash.set(hash, String(text))
    })
    const missing = [...missingByHash.entries()]
    const groupSize = this.batchSize * EMBEDDING_CONCURRENCY
    for (let offset = 0; offset < missing.length; offset += groupSize) {
      const group = missing.slice(offset, offset + groupSize)
      const batches: Array<Array<[string, string]>> = []
      for (
        let batchOffset = 0;
        batchOffset < group.length;
        batchOffset += this.batchSize
      )
        batches.push(group.slice(batchOffset, batchOffset + this.batchSize))
      const embeddedBatches = await Promise.all(
        batches.map((batch) =>
          this.delegate.embed(
            batch.map(([, text]) => text),
            options,
          ),
        ),
      )
      const inserted: Array<{ hash: string; vector: number[] }> = []
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex]!
        const embedded = embeddedBatches[batchIndex]!
        for (let index = 0; index < batch.length; index += 1) {
          const [hash] = batch[index]!
          const vector = embedded[index]!
          if (vector.length !== this.dimensions)
            throw new Error(`invalid cached embedding for ${hash}`)
          vectors.set(hash, vector)
          inserted.push({ hash, vector })
        }
      }
      await this.insertBatch(inserted)
      this.embeddedDocuments += inserted.length
      if (this.embeddedDocuments % 1_024 < inserted.length)
        console.log(
          `[LongMemEval] embedded ${this.embeddedDocuments} unique passages`,
        )
    }
    this.recentDocuments = new Map(
      hashes.map((hash) => [hash, vectors.get(hash)!.slice()]),
    )
    return hashes.map((hash) => vectors.get(hash)!.slice())
  }

  statistics() {
    return {
      providerId: this.id,
      embeddedDocuments: this.embeddedDocuments,
      cacheHits: this.cacheHits,
      poolErrors: this.poolErrors,
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async insertBatch(
    rows: ReadonlyArray<{ hash: string; vector: number[] }>,
  ): Promise<void> {
    if (!rows.length) return
    const values: unknown[] = []
    const placeholders = rows.map((row, index) => {
      const offset = index * 3
      values.push(this.id, row.hash, JSON.stringify(row.vector))
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}::jsonb)`
    })
    await this.pool.query(
      `INSERT INTO embedding_cache (provider_id, content_hash, embedding)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (provider_id, content_hash) DO NOTHING`,
      values,
    )
  }
}

function validateItem(item: LongMemEvalItem): void {
  if (
    !item.question_id ||
    !item.question ||
    !item.answer_session_ids?.length ||
    item.haystack_sessions?.length !== item.haystack_session_ids?.length ||
    item.haystack_sessions?.length !== item.haystack_dates?.length
  )
    throw new Error(
      `invalid LongMemEval item: ${item.question_id || 'unknown'}`,
    )
}

function parseLongMemEvalDate(value: string): number {
  const match = String(value).match(
    /^(\d{4})\/(\d{2})\/(\d{2}).*?(\d{2}):(\d{2})/,
  )
  if (!match) return 0
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  )
}

function countQuestionTypes(items: readonly LongMemEvalItem[]) {
  const counts: Record<string, number> = {}
  for (const item of items)
    counts[item.question_type] = (counts[item.question_type] ?? 0) + 1
  return counts
}

async function writeReport(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function rounded(value: number): number {
  return Number(value.toFixed(3))
}
