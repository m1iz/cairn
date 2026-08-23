import type {
  SessionCreateInput,
  SessionRepository,
} from '../contracts/persistence'
import {
  SessionStore,
  type SessionCreateOptions,
  type SessionEntry,
} from '../../sessions/store'

export class CurrentSessionRepository implements SessionRepository {
  constructor(private readonly store: SessionStore) {}

  sessionDirectory(sessionId: string): string {
    return this.store.sessionDir(sessionId)
  }

  list(options: { includeArchived?: boolean } = {}): SessionEntry[] {
    return this.store.list(options)
  }

  get(sessionId: string): SessionEntry | null {
    return this.store.get(sessionId)
  }

  create(title = '', options: SessionCreateInput = {}): SessionEntry {
    return this.store.create(title, options as SessionCreateOptions)
  }

  rename(sessionId: string, title: string): boolean {
    return this.store.rename(sessionId, title)
  }

  archive(sessionId: string): SessionEntry | null {
    return this.store.archive(sessionId)
  }

  delete(sessionId: string): boolean {
    return this.store.delete(sessionId)
  }
}
