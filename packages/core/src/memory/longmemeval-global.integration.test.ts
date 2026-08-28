import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { reciprocalRankFusion, applyRerankerScores } from './hybrid-ranking'
import {
  scoreLongMemEvalRankings,
  type LongMemEvalRanking,
} from './longmemeval-eval'
import { TeiEmbeddingProvider } from './tei-embedding-provider'
import { TeiMemoryReranker } from './tei-reranker'

const enabled = process.env.CAIRN_LONGMEMEVAL_GLOBAL === '1'
const dataPath = process.env.CAIRN_LONGMEMEVAL_DATA ?? ''
const databaseUrl = process.env.CAIRN_LONGMEMEVAL_DATABASE_URL ?? ''
const reportPath = process.env.CAIRN_LONGMEMEVAL_GLOBAL_REPORT ?? ''
const scaledCandidateSessions = Math.max(
  0,
  Math.trunc(Number(process.env.CAIRN_LONGMEMEVAL_CANDIDATE_SESSIONS) || 0),
)
const scaledSeeds = (
  process.env.CAIRN_LONGMEMEVAL_SEEDS ?? 'cairn-2k-a,cairn-2k-b,cairn-2k-c'
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const MAX_CHARS = 1_800
const OVERLAP = 160

interface Item {
  question_id: string
  question_type: string
  question: string
  answer_session_ids: string[]
  haystack_dates: string[]
  haystack_session_ids: string[]
  haystack_sessions: Array<Array<{ role: string; content: string }>>
}

interface StoredChunk {
  id: string
  sessionId: string
  text: string
  hash: string
}

describe.runIf(enabled && Boolean(dataPath) && Boolean(databaseUrl))(
  'LongMemEval global-corpus retrieval benchmark',
  () => {
    it('tunes on a deterministic development split and evaluates held-out cases', async () => {
      const started = performance.now()
      const items = JSON.parse(await readFile(dataPath, 'utf8')) as Item[]
      const pool = new Pool({ connectionString: databaseUrl, max: 4 })
      const embedder = new TeiEmbeddingProvider({
        endpoint: process.env.CAIRN_MEMORY_TEI_URL ?? 'http://127.0.0.1:8088',
        model: 'intfloat/multilingual-e5-small',
        dimensions: 384,
        timeoutMs: 120_000,
      })
      const reranker = new TeiMemoryReranker({
        endpoint:
          process.env.CAIRN_MEMORY_RERANKER_URL ?? 'http://127.0.0.1:8089',
        timeoutMs: 30_000,
      })
      try {
        const corpus = globalChunks(items)
        await prepareGlobalTable(pool, corpus)
        if (process.env.CAIRN_LONGMEMEVAL_PREPARE_ONLY === '1') {
          console.log(`[LongMemEval global] prepared ${corpus.length} chunks`)
          expect(corpus.length).toBeGreaterThan(100_000)
          return
        }
        if (scaledCandidateSessions > 0) {
          const report = await runScaledBenchmark({
            items,
            corpus,
            pool,
            embedder,
            reranker,
            candidateSessions: scaledCandidateSessions,
            seeds: scaledSeeds,
            started,
          })
          if (reportPath) {
            await mkdir(dirname(reportPath), { recursive: true })
            await writeFile(
              reportPath,
              `${JSON.stringify(report, null, 2)}\n`,
              'utf8',
            )
          }
          console.log('[LongMemEval scaled]', JSON.stringify(report, null, 2))
          expect(report.caseCountPerSeed).toBe(500)
          return
        }
        const split = deterministicSplit(items)
        const devRuns = await retrieveAll(pool, embedder, split.dev)
        const choices = [20, 40, 60].flatMap((k) =>
          [25, 50, 100].map((poolSize) => ({ k, poolSize })),
        )
        const tuned = choices
          .map((choice) => ({
            ...choice,
            metrics: scoreRuns(devRuns, choice, false),
          }))
          .sort(
            (a, b) =>
              b.metrics.ndcgAt5 - a.metrics.ndcgAt5 ||
              b.metrics.recallAt5 - a.metrics.recallAt5,
          )[0]!
        await populateRerankerScores(reranker, devRuns, tuned)
        const testRuns = await retrieveAll(pool, embedder, split.test)
        await populateRerankerScores(reranker, testRuns, tuned)
        const methods = {
          lexical: scoreChannel(testRuns, 'lexical'),
          vector: scoreChannel(testRuns, 'vector'),
          rrf: scoreRuns(testRuns, tuned, false),
          rrfReranked: scoreRuns(testRuns, tuned, true),
        }
        const report = {
          schemaVersion: 1,
          status: 'complete',
          benchmark: 'LongMemEval-S global unique-session corpus',
          corpus: {
            uniqueSessions: new Set(corpus.map((row) => row.sessionId)).size,
            uniqueChunks: corpus.length,
          },
          split: {
            development: split.dev.length,
            heldOutTest: split.test.length,
            rule: 'sha256(question_id), first 40% development',
          },
          tuning: {
            candidates: choices,
            selected: { rrfK: tuned.k, candidatePool: tuned.poolSize },
            developmentMetrics: tuned.metrics,
          },
          methods,
          chatModelApiCalls: 0,
          elapsedMs: round(performance.now() - started),
        }
        if (reportPath) {
          await mkdir(dirname(reportPath), { recursive: true })
          await writeFile(
            reportPath,
            `${JSON.stringify(report, null, 2)}\n`,
            'utf8',
          )
        }
        console.log('[LongMemEval global]', JSON.stringify(report, null, 2))
        expect(report.corpus.uniqueSessions).toBeGreaterThan(10_000)
        expect(methods.rrf.caseCount).toBe(split.test.length)
      } finally {
        await pool.end()
      }
    }, 43_200_000)
  },
)

interface QueryRun {
  item: Item
  latencyMs: number
  lexicalLatencyMs: number
  vectorLatencyMs: number
  lexical: Array<{ id: string; sessionId: string; text: string; score: number }>
  vector: Array<{ id: string; sessionId: string; text: string; score: number }>
  rerankScores: Map<string, number>
  rerankLatencyMs: number
}

async function retrieveAll(
  pool: Pool,
  embedder: TeiEmbeddingProvider,
  items: Item[],
  sessionPool?: (item: Item) => readonly string[],
): Promise<QueryRun[]> {
  const runs: QueryRun[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!
    const started = performance.now()
    const embeddingStarted = performance.now()
    const [queryVector] = await embedder.embed([item.question], {
      purpose: 'query',
    })
    const embeddingLatencyMs = performance.now() - embeddingStarted
    const allowed = sessionPool?.(item)
    const lexicalWhere = allowed
      ? `session_id = ANY($2::text[]) AND search_vector @@ websearch_to_tsquery('english', $1)`
      : `search_vector @@ websearch_to_tsquery('english', $1)`
    const vectorWhere = allowed ? `WHERE session_id = ANY($2::text[])` : ''
    const lexicalParams = allowed ? [item.question, allowed] : [item.question]
    const vectorParams = allowed
      ? [`[${queryVector!.join(',')}]`, allowed]
      : [`[${queryVector!.join(',')}]`]
    const [lexicalTimed, vectorTimed] = await Promise.all([
      timed(() =>
        pool.query(
          `SELECT chunk_id AS id, session_id AS "sessionId", text_content AS text,
                         ts_rank_cd(search_vector, websearch_to_tsquery('english', $1)) AS score
                    FROM longmemeval_global_chunks
                   WHERE ${lexicalWhere}
                   ORDER BY score DESC, chunk_id LIMIT 100`,
          lexicalParams,
        ),
      ),
      timed(() =>
        pool.query(
          `SELECT chunk_id AS id, session_id AS "sessionId", text_content AS text,
                         GREATEST(0, 1 - (embedding <=> $1::vector)) AS score
                    FROM longmemeval_global_chunks
                   ${vectorWhere}
                   ORDER BY embedding <=> $1::vector LIMIT 100`,
          vectorParams,
        ),
      ),
    ])
    const lexical = lexicalTimed.value.rows.map(normalizeRow)
    const vector = vectorTimed.value.rows.map(normalizeRow)
    runs.push({
      item,
      lexical,
      vector,
      rerankScores: new Map(),
      rerankLatencyMs: 0,
      latencyMs: performance.now() - started,
      lexicalLatencyMs: lexicalTimed.latencyMs,
      vectorLatencyMs: embeddingLatencyMs + vectorTimed.latencyMs,
    })
    if ((index + 1) % 25 === 0)
      console.log(`[LongMemEval global] ${index + 1}/${items.length}`)
  }
  return runs
}

async function runScaledBenchmark(input: {
  items: Item[]
  corpus: StoredChunk[]
  pool: Pool
  embedder: TeiEmbeddingProvider
  reranker: TeiMemoryReranker
  candidateSessions: number
  seeds: string[]
  started: number
}) {
  const allSessionIds = unique(input.corpus.map((row) => row.sessionId))
  const seedReports = []
  for (const seed of input.seeds) {
    const distractors = [...allSessionIds].sort((left, right) =>
      sha(`${seed}\0${left}`).localeCompare(sha(`${seed}\0${right}`)),
    )
    const pools = new Map(
      input.items.map((item) => [
        item.question_id,
        fixedSessionPool(item, distractors, input.candidateSessions),
      ]),
    )
    const runs = await retrieveAll(
      input.pool,
      input.embedder,
      input.items,
      (item) => pools.get(item.question_id)!,
    )
    const choice = { k: 40, poolSize: 25 }
    await populateRerankerScores(input.reranker, runs, choice)
    seedReports.push({
      seed,
      methods: {
        lexical: scoreChannel(runs, 'lexical'),
        vector: scoreChannel(runs, 'vector'),
        rrf: scoreRuns(runs, choice, false),
        rrfReranked: scoreRuns(runs, choice, true),
      },
    })
  }
  return {
    schemaVersion: 1,
    status: 'complete',
    benchmark: 'LongMemEval-S fixed distractor sessions',
    caseCountPerSeed: input.items.length,
    candidateSessionsPerCase: input.candidateSessions,
    seeds: input.seeds,
    protocol: {
      goldAndOfficialHaystackPreserved: true,
      distractorOrdering: 'sha256(seed + NUL + session_id)',
      parametersFrozen: {
        rrfK: 40,
        candidatePoolPerChannel: 25,
        rerankTopN: 20,
      },
      chatModelApiCalls: 0,
    },
    aggregate: aggregateSeedMetrics(seedReports),
    seedReports,
    elapsedMs: round(performance.now() - input.started),
  }
}

function fixedSessionPool(
  item: Item,
  distractors: readonly string[],
  size: number,
): string[] {
  const selected = unique([
    ...item.haystack_session_ids,
    ...item.answer_session_ids,
  ])
  const seen = new Set(selected)
  for (const sessionId of distractors) {
    if (seen.has(sessionId)) continue
    selected.push(sessionId)
    seen.add(sessionId)
    if (selected.length >= size) break
  }
  return selected.slice(0, size)
}

function aggregateSeedMetrics(
  reports: Array<{
    methods: Record<string, ReturnType<typeof scoreLongMemEvalRankings>>
  }>,
) {
  const methodIds = Object.keys(reports[0]?.methods ?? {})
  return Object.fromEntries(
    methodIds.map((method) => {
      const rows = reports.map((report) => report.methods[method]!)
      return [
        method,
        Object.fromEntries(
          Object.keys(rows[0] ?? {}).map((key) => {
            const values = rows.map((row) =>
              Number(row[key as keyof typeof row]),
            )
            const mean =
              values.reduce((sum, value) => sum + value, 0) / values.length
            const variance =
              values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
              values.length
            return [key, { mean, standardDeviation: Math.sqrt(variance) }]
          }),
        ),
      ]
    }),
  )
}

async function populateRerankerScores(
  reranker: TeiMemoryReranker,
  runs: QueryRun[],
  choice: { k: number; poolSize: number },
) {
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!
    const pool = fuse(run.lexical, run.vector, choice).slice(0, 20)
    const started = performance.now()
    run.rerankScores = await reranker.rerank(run.item.question, pool)
    run.rerankLatencyMs = performance.now() - started
    if ((index + 1) % 25 === 0)
      console.log(`[LongMemEval rerank] ${index + 1}/${runs.length}`)
  }
}

function scoreRuns(
  runs: QueryRun[],
  choice: { k: number; poolSize: number },
  reranked: boolean,
) {
  return scoreLongMemEvalRankings(
    runs.map((run) => {
      const fused = fuse(run.lexical, run.vector, choice)
      const ranked = reranked
        ? applyRerankerScores(fused.slice(0, 20), run.rerankScores)
        : fused
      return ranking(run, ranked, reranked)
    }),
  )
}

function scoreChannel(runs: QueryRun[], channel: 'lexical' | 'vector') {
  return scoreLongMemEvalRankings(
    runs.map((run) => ({
      ...ranking(run, run[channel]),
      latencyMs:
        channel === 'lexical' ? run.lexicalLatencyMs : run.vectorLatencyMs,
    })),
  )
}

function ranking(
  run: QueryRun,
  rows: Array<{ sessionId: string }>,
  includeReranker = false,
): LongMemEvalRanking {
  return {
    expectedSessionIds: run.item.answer_session_ids,
    retrievedSessionIds: unique(rows.map((row) => row.sessionId)).slice(0, 5),
    latencyMs: run.latencyMs + (includeReranker ? run.rerankLatencyMs : 0),
  }
}

function fuse(
  lexical: QueryRun['lexical'],
  vector: QueryRun['vector'],
  choice: { k: number; poolSize: number },
) {
  const byId = new Map<
    string,
    QueryRun['lexical'][number] & { lexicalScore: number; vectorScore: number }
  >()
  for (const row of lexical.slice(0, choice.poolSize))
    byId.set(row.id, { ...row, lexicalScore: row.score, vectorScore: 0 })
  for (const row of vector.slice(0, choice.poolSize)) {
    const prior = byId.get(row.id)
    byId.set(row.id, {
      ...(prior ?? row),
      lexicalScore: prior?.lexicalScore ?? 0,
      vectorScore: row.score,
    })
  }
  return reciprocalRankFusion([...byId.values()], choice.k)
}

async function prepareGlobalTable(
  pool: Pool,
  chunks: StoredChunk[],
): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
  await pool.query(`CREATE TABLE IF NOT EXISTS longmemeval_global_chunks (
    chunk_id text PRIMARY KEY, session_id text NOT NULL, text_content text NOT NULL,
    content_hash char(64) NOT NULL, search_vector tsvector NOT NULL, embedding vector(384) NOT NULL
  )`)
  const count = Number(
    (
      await pool.query(
        'SELECT count(*) AS count FROM longmemeval_global_chunks',
      )
    ).rows[0]?.count ?? 0,
  )
  if (count < chunks.length - 10) {
    await pool.query('DROP INDEX IF EXISTS longmemeval_global_fts')
    await pool.query('DROP INDEX IF EXISTS longmemeval_global_hnsw')
    await pool.query('TRUNCATE longmemeval_global_chunks')
    for (let offset = 0; offset < chunks.length; offset += 500) {
      const batch = chunks.slice(offset, offset + 500)
      await pool.query(
        `INSERT INTO longmemeval_global_chunks
        (chunk_id, session_id, text_content, content_hash, search_vector, embedding)
        SELECT x.id, x.session_id, x.text_content, x.content_hash,
               to_tsvector('english', x.text_content), cache.embedding::text::vector
          FROM jsonb_to_recordset($1::jsonb) AS x(id text, session_id text, text_content text, content_hash char(64))
          JOIN embedding_cache cache ON cache.provider_id = $2 AND cache.content_hash = x.content_hash`,
        [
          JSON.stringify(
            batch.map((row) => ({
              id: row.id,
              session_id: row.sessionId,
              text_content: row.text,
              content_hash: row.hash,
            })),
          ),
          'tei:intfloat/multilingual-e5-small:384',
        ],
      )
    }
  }
  await pool.query("SET maintenance_work_mem = '1GB'")
  await pool.query(
    'CREATE INDEX IF NOT EXISTS longmemeval_global_fts ON longmemeval_global_chunks USING gin(search_vector)',
  )
  await pool.query(
    'CREATE INDEX IF NOT EXISTS longmemeval_global_hnsw ON longmemeval_global_chunks USING hnsw(embedding vector_cosine_ops)',
  )
  await pool.query('ANALYZE longmemeval_global_chunks')
}

function globalChunks(items: Item[]): StoredChunk[] {
  const sessions = new Map<
    string,
    { date: string; turns: Item['haystack_sessions'][number] }
  >()
  for (const item of items)
    item.haystack_session_ids.forEach((id, index) => {
      if (!sessions.has(id))
        sessions.set(id, {
          date: item.haystack_dates[index]!,
          turns: item.haystack_sessions[index]!,
        })
    })
  const chunks: StoredChunk[] = []
  for (const [sessionId, session] of sessions) {
    const text = [
      `Session date: ${session.date}`,
      ...session.turns.map(
        (turn) => `${turn.role.toUpperCase()}: ${turn.content}`,
      ),
    ].join('\n\n')
    split(text).forEach((part, index) =>
      chunks.push({
        id: sha(`${sessionId}\0${index}\0${part}`),
        sessionId,
        text: part,
        hash: sha(part),
      }),
    )
  }
  return chunks
}

function split(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text]
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + MAX_CHARS)
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf('\n\n', end),
        text.lastIndexOf(' ', end),
      )
      if (boundary > start + MAX_CHARS * 0.6) end = boundary
    }
    const part = text.slice(start, end).trim()
    if (part) parts.push(part)
    if (end >= text.length) break
    start = Math.max(start + 1, end - OVERLAP)
  }
  return parts
}

function deterministicSplit(items: Item[]) {
  const sorted = [...items].sort((a, b) =>
    sha(a.question_id).localeCompare(sha(b.question_id)),
  )
  return { dev: sorted.slice(0, 200), test: sorted.slice(200) }
}
function normalizeRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    text: String(row.text),
    score: Number(row.score) || 0,
  }
}
function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}
function sha(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
function round(value: number) {
  return Number(value.toFixed(3))
}
async function timed<T>(
  run: () => Promise<T>,
): Promise<{ value: T; latencyMs: number }> {
  const started = performance.now()
  const value = await run()
  return { value, latencyMs: performance.now() - started }
}
