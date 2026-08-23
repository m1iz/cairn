import type { Command, Query } from './messages'

export type HarnessLifecycle = 'created' | 'running' | 'closed'

export interface HarnessStatus {
  lifecycle: HarnessLifecycle
  startedAt: number | null
  closedAt: number | null
}

export interface StartHarnessCommand extends Command<HarnessStatus> {
  kind: 'harness.start'
}

export interface CloseHarnessCommand extends Command<HarnessStatus> {
  kind: 'harness.close'
}

export interface GetHarnessStatusQuery extends Query<HarnessStatus> {
  kind: 'harness.status'
}
