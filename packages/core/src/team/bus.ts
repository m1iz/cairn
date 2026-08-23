import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { TeamMessage, validateActorName } from './models'
import { TeamStore } from './store'

/**
 * 审计 P1-4：inbox jsonl 此前永久追加、无归档，每次 read/recent/unreadCount 都要
 * 全文件重新解析。已读游标（绝对偏移量）前移超过阈值后，把已读前缀搬进归档文件，
 * 热文件只保留最近一批已读 + 全部未读——只归档 `[0, cursor)`，绝不动未读区间，
 * 避免轮转导致未读消息被误判为已消费或直接不可见。
 */
const HOT_CURSOR_THRESHOLD = 5000
const HOT_CURSOR_KEEP = 2000

export class MessageBus {
  readonly store: TeamStore

  constructor(store: TeamStore) {
    this.store = store
  }

  append(message: TeamMessage): TeamMessage {
    const actor = validateActorName(message.to)
    const path = this.store.inboxPath(actor)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(message.toDict()) + '\n', 'utf8')
    return message
  }

  send(opts: {
    from_actor: string
    to: string
    content: string
    type?: string
    task_id?: string | null
    in_reply_to?: string | null
    meta?: Record<string, unknown> | null
  }): TeamMessage {
    return this.append(TeamMessage.create(opts))
  }

  read(
    actor: string,
    opts: { limit?: number; mark_read?: boolean } = {},
  ): TeamMessage[] {
    const safe = validateActorName(actor)
    const messages = this.allMessages(safe)
    const cursor = Math.min(this.store.readCursor(safe), messages.length)
    const limit = opts.limit ?? 20
    const unread =
      limit <= 0
        ? messages.slice(cursor)
        : messages.slice(cursor, cursor + limit)
    if ((opts.mark_read ?? true) && unread.length) {
      this.store.writeCursor(safe, cursor + unread.length)
      this.rotateReadPrefixIfNeeded(safe)
    }
    return unread
  }

  /** 只归档 `[0, cursor - keep)` 这段已读前缀，未读区间永不触碰。 */
  private rotateReadPrefixIfNeeded(actor: string): void {
    const cursor = this.store.readCursor(actor)
    if (cursor < HOT_CURSOR_THRESHOLD) return
    const archiveCount = cursor - HOT_CURSOR_KEEP
    if (archiveCount <= 0) return
    const path = this.store.inboxPath(actor)
    if (!existsSync(path)) return
    const lines = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
    if (lines.length <= archiveCount) return
    const archived = lines.slice(0, archiveCount)
    const kept = lines.slice(archiveCount)

    const archiveDir = join(dirname(path), 'archive')
    mkdirSync(archiveDir, { recursive: true })
    const archivePath = join(archiveDir, `${actor}.jsonl`)
    appendFileSync(archivePath, archived.join('\n') + '\n', 'utf8')

    const tmp = `${path}.${randomUUID().replace(/-/g, '')}.tmp`
    try {
      writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf8')
      renameSync(tmp, path)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      throw error
    }
    this.store.writeCursor(actor, HOT_CURSOR_KEEP)
  }

  recent(actor: string, opts: { limit?: number } = {}): TeamMessage[] {
    const messages = this.allMessages(actor)
    const limit = opts.limit ?? 50
    return limit <= 0 ? messages : messages.slice(-limit)
  }

  unreadCount(actor: string): number {
    const safe = validateActorName(actor)
    const messages = this.allMessages(safe)
    const cursor = Math.min(this.store.readCursor(safe), messages.length)
    return Math.max(0, messages.length - cursor)
  }

  allMessages(actor: string): TeamMessage[] {
    const safe = validateActorName(actor)
    const path = this.store.inboxPath(safe)
    if (!existsSync(path)) return []
    const out: TeamMessage[] = []
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const raw = JSON.parse(line)
        if (raw && typeof raw === 'object' && !Array.isArray(raw))
          out.push(TeamMessage.fromDict(raw))
      } catch {}
    }
    return out
  }
}
