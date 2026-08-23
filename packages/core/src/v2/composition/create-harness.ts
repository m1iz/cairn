import { CommandBus, QueryBus } from '../application/message-bus'
import type {
  CloseHarnessCommand,
  GetHarnessStatusQuery,
  HarnessLifecycle,
  HarnessStatus,
  StartHarnessCommand,
} from '../contracts/harness'
import type { ClockPort } from '../model/model-port'
import { systemClock } from '../model/model-port'

export interface HarnessPorts {
  clock: ClockPort
}

export interface CairnHarness {
  commands: CommandBus
  queries: QueryBus
  start(): Promise<HarnessStatus>
  close(): Promise<HarnessStatus>
  status(): Promise<HarnessStatus>
}

export function createHarness(
  suppliedPorts: Partial<HarnessPorts> = {},
): CairnHarness {
  const ports: HarnessPorts = {
    clock: suppliedPorts.clock ?? systemClock,
  }
  const commands = new CommandBus()
  const queries = new QueryBus()
  let lifecycle: HarnessLifecycle = 'created'
  let startedAt: number | null = null
  let closedAt: number | null = null

  const snapshot = (): HarnessStatus => ({
    lifecycle,
    startedAt,
    closedAt,
  })

  commands.register<StartHarnessCommand>('harness.start', () => {
    if (lifecycle === 'closed') throw new Error('closed harness cannot restart')
    if (lifecycle === 'created') {
      lifecycle = 'running'
      startedAt = ports.clock.now()
    }
    return snapshot()
  })
  commands.register<CloseHarnessCommand>('harness.close', () => {
    if (lifecycle !== 'closed') {
      lifecycle = 'closed'
      closedAt = ports.clock.now()
    }
    return snapshot()
  })
  queries.register<GetHarnessStatusQuery>('harness.status', snapshot)

  return {
    commands,
    queries,
    start: () =>
      commands.execute<StartHarnessCommand>({ kind: 'harness.start' }),
    close: () =>
      commands.execute<CloseHarnessCommand>({ kind: 'harness.close' }),
    status: () =>
      queries.ask<GetHarnessStatusQuery>({ kind: 'harness.status' }),
  }
}
