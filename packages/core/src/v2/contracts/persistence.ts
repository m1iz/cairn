export type PersistedEvent = Record<string, unknown>

export interface RuntimeEventAppendOptions {
  sessionId?: string | null
  turnId?: string | null
}

export interface RuntimeEventReplayOptions {
  sessionId?: string | null
  limit?: number | null
  includeArchive?: boolean | null
  compact?: boolean | null
}

export interface RuntimeEventRepository {
  readonly latestSequence: number
  append(
    event: PersistedEvent,
    options?: RuntimeEventAppendOptions,
  ): PersistedEvent
  replayProjectionAfter(
    sequence: number,
    options?: RuntimeEventReplayOptions,
  ): PersistedEvent[]
  replayEnvelopesAfter(
    sequence: number,
    options?: RuntimeEventReplayOptions,
  ): PersistedEvent[]
}

export interface RuntimeEventRepositoryFactory {
  openSession(sessionDirectory: string): RuntimeEventRepository
}

export interface SessionRecord {
  id: string
  title: string
  created_at: string
  updated_at: string
  preview: string
  message_count: number
  title_status: string
  mode: 'chat' | 'build'
  project_id: string | null
  project_path: string | null
  project_name: string | null
  archived_at: string | null
  control_pending: {
    kind: 'ask' | 'plan'
    label: string
    tone: 'blue' | 'green'
    interaction_id: string
    updated_at: number
  } | null
  parent_session_id: string | null
  lineage_root_id: string | null
  transition_reason: 'clear' | null
  transitioned_to_session_id: string | null
  transitioned_at: string | null
  version: number
}

export interface SessionCreateInput {
  id?: string | null
  titleStatus?: string | null
  mode?: string
  project?: Record<string, unknown> | null
  parentSessionId?: string | null
  lineageRootId?: string | null
  transitionReason?: 'clear' | null
}

export interface SessionRepository {
  sessionDirectory(sessionId: string): string
  list(options?: { includeArchived?: boolean }): SessionRecord[]
  get(sessionId: string): SessionRecord | null
  create(title?: string, options?: SessionCreateInput): SessionRecord
  rename(sessionId: string, title: string): boolean
  archive(sessionId: string): SessionRecord | null
  delete(sessionId: string): boolean
}
