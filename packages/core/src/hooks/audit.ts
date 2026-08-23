import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { appendJsonl, readJsonl } from '../store/jsonl'
import type { HookAuditRecord } from './models'
import type { HookAuditRunRecordV2 } from './orchestrator'

export class HookAuditStore {
  readonly auditPath: string
  readonly auditDir: string

  constructor(stateRoot: string) {
    this.auditPath = join(stateRoot, 'hooks', 'audit.jsonl')
    this.auditDir = join(stateRoot, 'hooks', 'audit')
  }

  async append(record: HookAuditRecord): Promise<void> {
    await appendJsonl(this.auditPath, record)
  }

  async replay(opts: { limit?: number } = {}): Promise<{
    records: HookAuditRecord[]
    badLines: { line: number; raw: string }[]
  }> {
    const replay = await readJsonl<HookAuditRecord>(this.auditPath)
    const limit = Math.max(0, Math.trunc(opts.limit ?? 100))
    const records = limit > 0 ? replay.records.slice(-limit) : []
    return { records, badLines: replay.badLines }
  }

  async appendRun(record: HookAuditRunRecordV2): Promise<void> {
    await appendJsonl(
      this.dailyPath(record.startedAt),
      sanitizeRunRecord(record),
    )
  }

  async replayRuns(opts: { limit?: number } = {}): Promise<{
    records: HookAuditRunRecordV2[]
    badLines: Array<{ path: string; line: number; raw: string }>
  }> {
    let names: string[] = []
    try {
      names = (await readdir(this.auditDir))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort()
    } catch {
      return { records: [], badLines: [] }
    }
    const records: HookAuditRunRecordV2[] = []
    const badLines: Array<{ path: string; line: number; raw: string }> = []
    for (const name of names) {
      const path = join(this.auditDir, name)
      const replay = await readJsonl<HookAuditRunRecordV2>(path)
      records.push(...replay.records)
      badLines.push(...replay.badLines.map((line) => ({ path, ...line })))
    }
    const limit = Math.max(0, Math.trunc(opts.limit ?? 100))
    return { records: limit > 0 ? records.slice(-limit) : [], badLines }
  }

  dailyPath(startedAt: string): string {
    const date =
      /^\d{4}-\d{2}-\d{2}/.exec(startedAt)?.[0] ??
      new Date().toISOString().slice(0, 10)
    return join(this.auditDir, `${date}.jsonl`)
  }
}

function sanitizeRunRecord(record: HookAuditRunRecordV2): HookAuditRunRecordV2 {
  return {
    ...record,
    source: {
      ...record.source,
      blockedReason: record.source.blockedReason
        ? scrub(record.source.blockedReason)
        : null,
    },
    reason: scrub(record.reason),
  }
}

function scrub(value: string): string {
  return value
    .replace(
      /(api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .slice(0, 1_000)
}
