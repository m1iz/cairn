import {
  RuntimeEventStore,
  type RuntimeAppendOptions,
  type RuntimeReplayOptions,
} from './store'

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

export class RuntimeEventRepository {
  constructor(private readonly store: RuntimeEventStore) {}

  get latestSequence(): number {
    return this.store.latestSeq
  }

  append(
    event: PersistedEvent,
    options: RuntimeEventAppendOptions = {},
  ): PersistedEvent {
    return this.store.append(event, options as RuntimeAppendOptions)
  }

  replayProjectionAfter(
    sequence: number,
    options: RuntimeEventReplayOptions = {},
  ): PersistedEvent[] {
    return this.store.replayAfter(sequence, options as RuntimeReplayOptions)
  }

  replayEnvelopesAfter(
    sequence: number,
    options: RuntimeEventReplayOptions = {},
  ): PersistedEvent[] {
    return this.store.replayEnvelopesAfter(
      sequence,
      options as RuntimeReplayOptions,
    ) as unknown as PersistedEvent[]
  }
}

export class RuntimeEventRepositoryFactory {
  openSession(sessionDirectory: string): RuntimeEventRepository {
    return new RuntimeEventRepository(
      new RuntimeEventStore(sessionDirectory, { sessionDirOverride: true }),
    )
  }

  wrap(store: RuntimeEventStore): RuntimeEventRepository {
    return new RuntimeEventRepository(store)
  }
}
