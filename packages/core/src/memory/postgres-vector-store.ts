import { createHash } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import type {
  HybridMemoryAccessRecord,
  HybridMemoryChunkInput,
  HybridMemorySearchScope,
  HybridMemoryVectorStore,
  HybridMemoryVectorStoreDiagnostics,
  MemoryEmbeddingProvider,
} from './hybrid-retrieval'

export interface PostgresHybridMemoryVectorStoreOptions {
  connectionString: string
  connectionTimeoutMs?: number
  pool?: Pool
}

/** Persistent embedding cache and pgvector candidate source. */
export class PostgresHybridMemoryVectorStore implements HybridMemoryVectorStore {
  readonly id = 'postgres-pgvector'
  private readonly pool: Pool
  private schemaReady: Promise<void> | null = null
  private available = false
  private lastError: string | null = null

  constructor(opts: PostgresHybridMemoryVectorStoreOptions) {
    this.pool =
      opts.pool ??
      new Pool({
        connectionString: opts.connectionString,
        connectionTimeoutMillis: Math.max(
          250,
          Math.trunc(opts.connectionTimeoutMs ?? 2_000),
        ),
        max: 4,
        idleTimeoutMillis: 30_000,
        application_name: 'cairn-hybrid-memory',
      })
    this.pool.on('error', (error) => this.recordError(error))
  }

  async loadEmbeddings(
    chunks: readonly HybridMemoryChunkInput[],
    provider: MemoryEmbeddingProvider,
    signal?: AbortSignal,
  ): Promise<Map<string, number[]>> {
    if (!chunks.length) return new Map()
    await this.ensureSchema(provider.dimensions)
    throwIfAborted(signal)
    const result = await this.pool.query<{
      chunk_id: string
      embedding: string
    }>(
      `SELECT chunk_id, embedding::text AS embedding
         FROM memory_chunks
        WHERE embedding_provider = $1 AND chunk_id = ANY($2::text[])`,
      [provider.id, chunks.map((chunk) => chunk.id)],
    )
    const embeddings = new Map<string, number[]>()
    for (const row of result.rows) {
      const vector = parseVector(row.embedding)
      if (vector.length === provider.dimensions)
        embeddings.set(row.chunk_id, vector)
    }
    this.recordSuccess()
    return embeddings
  }

  async sync(
    chunks: readonly HybridMemoryChunkInput[],
    embeddings: ReadonlyMap<string, number[]>,
    provider: MemoryEmbeddingProvider,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!chunks.length) return
    await this.ensureSchema(provider.dimensions)
    throwIfAborted(signal)
    const rows = chunks
      .map((chunk) => {
        const embedding = embeddings.get(chunk.id)
        if (!embedding) return null
        return {
          namespace: namespaceFor(chunk),
          chunk_id: chunk.id,
          source: chunk.source,
          project_id: chunk.projectId ?? null,
          session_id: chunk.sessionId ?? null,
          path: chunk.path,
          start_line: chunk.startLine ?? 1,
          end_line: chunk.endLine ?? 1,
          created_at: new Date(chunk.createdAt).toISOString(),
          access_count: chunk.accessCount ?? 0,
          content_hash: createHash('sha256')
            .update(chunk.text, 'utf8')
            .digest('hex'),
          text_content: chunk.text,
          embedding_provider: provider.id,
          embedding: vectorLiteral(embedding, provider.dimensions),
        }
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
    if (!rows.length) return

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      throwIfAborted(signal)
      await client.query(
        `INSERT INTO memory_chunks (
           namespace, chunk_id, source, project_id, session_id, path,
           start_line, end_line, created_at, access_count, content_hash,
           text_content, embedding_provider, embedding, updated_at
         )
         SELECT x.namespace, x.chunk_id, x.source, x.project_id, x.session_id,
                x.path, x.start_line, x.end_line, x.created_at, x.access_count,
                x.content_hash, x.text_content, x.embedding_provider,
                x.embedding::vector, now()
           FROM jsonb_to_recordset($1::jsonb) AS x(
             namespace text, chunk_id text, source text, project_id text,
             session_id text, path text, start_line integer, end_line integer,
             created_at timestamptz, access_count integer, content_hash char(64),
             text_content text, embedding_provider text, embedding text
           )
         ON CONFLICT (namespace, chunk_id) DO UPDATE SET
           source = EXCLUDED.source,
           project_id = EXCLUDED.project_id,
           session_id = EXCLUDED.session_id,
           path = EXCLUDED.path,
           start_line = EXCLUDED.start_line,
           end_line = EXCLUDED.end_line,
           created_at = EXCLUDED.created_at,
           access_count = GREATEST(memory_chunks.access_count, EXCLUDED.access_count),
           content_hash = EXCLUDED.content_hash,
           text_content = EXCLUDED.text_content,
           embedding_provider = EXCLUDED.embedding_provider,
           embedding = EXCLUDED.embedding,
           updated_at = now()`,
        [JSON.stringify(rows)],
      )
      await removeStaleRows(client, rows, provider.id)
      await client.query('COMMIT')
      this.recordSuccess()
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      this.recordError(error)
      throw error
    } finally {
      client.release()
    }
  }

  async search(
    embedding: readonly number[],
    scope: HybridMemorySearchScope,
    maxResults: number,
    provider: MemoryEmbeddingProvider,
    signal?: AbortSignal,
  ): Promise<Map<string, number>> {
    await this.ensureSchema(provider.dimensions)
    throwIfAborted(signal)
    const vector = vectorLiteral(embedding, provider.dimensions)
    const limit = Math.min(100, Math.max(1, Math.trunc(maxResults)))
    const values: unknown[] = [vector, provider.id]
    let visibility: string
    if (scope.mode === 'build') {
      values.push(String(scope.projectId ?? ''))
      visibility = `project_id = $3 AND source IN ('project', 'session')`
    } else {
      values.push(String(scope.sessionId ?? ''))
      visibility = `(source = 'global' OR (
        source = 'session' AND project_id IS NULL AND
        (session_id IS NULL OR session_id = $3)
      ))`
    }
    values.push(limit)
    const result = await this.pool.query<{ chunk_id: string; score: number }>(
      `SELECT chunk_id, GREATEST(0, 1 - (embedding <=> $1::vector)) AS score
         FROM memory_chunks
        WHERE embedding_provider = $2 AND ${visibility}
        ORDER BY embedding <=> $1::vector
        LIMIT $4`,
      values,
    )
    this.recordSuccess()
    return new Map(
      result.rows.map((row) => [row.chunk_id, Number(row.score) || 0]),
    )
  }

  async recordAccess(
    records: readonly HybridMemoryAccessRecord[],
    provider: MemoryEmbeddingProvider,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!records.length) return
    await this.ensureSchema(provider.dimensions)
    throwIfAborted(signal)
    const unique = new Map<string, { namespace: string; chunk_id: string }>()
    for (const record of records) {
      const row = {
        namespace: namespaceFor(record),
        chunk_id: String(record.chunkId),
      }
      unique.set(`${row.namespace}\u0000${row.chunk_id}`, row)
    }
    try {
      await this.pool.query(
        `UPDATE memory_chunks AS stored
            SET access_count = stored.access_count + 1
           FROM jsonb_to_recordset($1::jsonb) AS hit(
             namespace text, chunk_id text
           )
          WHERE stored.embedding_provider = $2
            AND stored.namespace = hit.namespace
            AND stored.chunk_id = hit.chunk_id`,
        [JSON.stringify([...unique.values()]), provider.id],
      )
      this.recordSuccess()
    } catch (error) {
      this.recordError(error)
      throw error
    }
  }

  diagnostics(): HybridMemoryVectorStoreDiagnostics {
    return { id: this.id, available: this.available, lastError: this.lastError }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async ensureSchema(dimensions: number): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.createSchema(dimensions).catch((error) => {
        this.schemaReady = null
        this.recordError(error)
        throw error
      })
    }
    await this.schemaReady
  }

  private async createSchema(dimensions: number): Promise<void> {
    const safeDimensions = Math.min(8_192, Math.max(1, Math.trunc(dimensions)))
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector')
    await this.pool.query(`CREATE TABLE IF NOT EXISTS memory_chunks (
      namespace text NOT NULL,
      chunk_id text NOT NULL,
      source text NOT NULL CHECK (source IN ('global', 'project', 'session')),
      project_id text,
      session_id text,
      path text NOT NULL,
      start_line integer NOT NULL,
      end_line integer NOT NULL,
      created_at timestamptz NOT NULL,
      access_count integer NOT NULL DEFAULT 0,
      content_hash char(64) NOT NULL,
      text_content text NOT NULL,
      embedding_provider text NOT NULL,
      embedding vector(${safeDimensions}) NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (namespace, chunk_id)
    )`)
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS memory_chunks_embedding_hnsw
         ON memory_chunks USING hnsw (embedding vector_cosine_ops)`,
    )
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS memory_chunks_scope_idx
         ON memory_chunks (embedding_provider, source, project_id, session_id)`,
    )
    this.recordSuccess()
  }

  private recordSuccess(): void {
    this.available = true
    this.lastError = null
  }

  private recordError(error: unknown): void {
    this.available = false
    this.lastError = error instanceof Error ? error.message : String(error)
  }
}

async function removeStaleRows(
  client: PoolClient,
  rows: ReadonlyArray<{ namespace: string; chunk_id: string }>,
  providerId: string,
): Promise<void> {
  const namespaces = [...new Set(rows.map((row) => row.namespace))]
  const ids = rows.map((row) => row.chunk_id)
  await client.query(
    `DELETE FROM memory_chunks
      WHERE embedding_provider = $1
        AND namespace = ANY($2::text[])
        AND NOT (chunk_id = ANY($3::text[]))`,
    [providerId, namespaces, ids],
  )
}

function namespaceFor(
  chunk: Pick<
    HybridMemoryChunkInput,
    'source' | 'projectId' | 'sessionId'
  >,
): string {
  if (chunk.source === 'global') return 'global'
  if (chunk.source === 'project') return `project:${chunk.projectId ?? ''}`
  return `session:${chunk.projectId ?? ''}:${chunk.sessionId ?? ''}`
}

function vectorLiteral(values: readonly number[], dimensions: number): string {
  if (
    values.length !== dimensions ||
    values.some((value) => !Number.isFinite(value))
  )
    throw new Error(`invalid embedding: expected ${dimensions} finite values`)
  return `[${values.join(',')}]`
}

function parseVector(value: string): number[] {
  const normalized = String(value).trim()
  if (!normalized.startsWith('[') || !normalized.endsWith(']')) return []
  if (normalized === '[]') return []
  return normalized.slice(1, -1).split(',').map(Number).filter(Number.isFinite)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}
