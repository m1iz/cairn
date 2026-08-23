import type {
  PersistedEvent,
  RuntimeEventAppendOptions,
  RuntimeEventReplayOptions,
  RuntimeEventRepository,
  RuntimeEventRepositoryFactory,
} from '../contracts/persistence'
import {
  RuntimeEventStore,
  type RuntimeAppendOptions,
  type RuntimeReplayOptions,
} from '../../runtime/store'

export class CurrentRuntimeEventRepository implements RuntimeEventRepository {
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

export class CurrentRuntimeEventRepositoryFactory implements RuntimeEventRepositoryFactory {
  openSession(sessionDirectory: string): RuntimeEventRepository {
    return new CurrentRuntimeEventRepository(
      new RuntimeEventStore(sessionDirectory, { sessionDirOverride: true }),
    )
  }

  wrap(store: RuntimeEventStore): RuntimeEventRepository {
    return new CurrentRuntimeEventRepository(store)
  }
}
