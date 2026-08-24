import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { appendJsonl, readJsonl } from '../store/jsonl'
import type { HookAuditRunRecord } from './orchestrator'

export class HookAuditStore {
  readonly auditDir: string

  constructor(stateRoot: string) {
    this.auditDir = join(stateRoot, 'hooks', 'audit')
  }

  async appendRun(record: HookAuditRunRecord): Promise<void> {
    await appendJsonl(
      this.dailyPath(record.startedAt),
      sanitizeRunRecord(record),
    )
  }

  async replayRuns(opts: { limit?: number } = {}): Promise<{
    records: HookAuditRunRecord[]
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
    const records: HookAuditRunRecord[] = []
    const badLines: Array<{ path: string; line: number; raw: string }> = []
    for (const name of names) {
      const path = join(this.auditDir, name)
      const replay = await readJsonl<HookAuditRunRecord>(path)
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

function sanitizeRunRecord(record: HookAuditRunRecord): HookAuditRunRecord {
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
