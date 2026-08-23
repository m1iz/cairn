import { SchedulerJob, SchedulerPayload, SchedulerSchedule } from './models'

export const SYSTEM_JOB_IDS = new Set([
  'memory-maintenance',
  'runtime-maintenance',
  'team-stale-recovery',
  'token-ledger-maintenance',
  'watchlist-check',
])

export function defaultSystemJobs(now: number): SchedulerJob[] {
  return [
    systemJob(
      'memory-maintenance',
      'Memory maintenance',
      new SchedulerSchedule({
        kind: 'cron',
        expr: '17 3 * * *',
        tz: 'Asia/Shanghai',
      }),
      now,
    ),
    systemJob(
      'runtime-maintenance',
      'Runtime event maintenance',
      new SchedulerSchedule({
        kind: 'cron',
        expr: '37 3 * * *',
        tz: 'Asia/Shanghai',
      }),
      now,
    ),
    systemJob(
      'team-stale-recovery',
      'Team stale recovery',
      new SchedulerSchedule({ kind: 'every', every_ms: 60 * 60 * 1000 }),
      now,
    ),
    systemJob(
      'token-ledger-maintenance',
      'Token ledger maintenance',
      new SchedulerSchedule({
        kind: 'cron',
        expr: '47 3 * * *',
        tz: 'Asia/Shanghai',
      }),
      now,
    ),
    systemJob(
      'watchlist-check',
      'Watchlist heartbeat',
      new SchedulerSchedule({ kind: 'every', every_ms: 6 * 60 * 60 * 1000 }),
      now,
    ),
  ]
}

export function isSystemJob(jobId: string): boolean {
  return SYSTEM_JOB_IDS.has(String(jobId || ''))
}

function systemJob(
  id: string,
  name: string,
  schedule: SchedulerSchedule,
  now: number,
): SchedulerJob {
  return SchedulerJob.create({
    jobId: id,
    name,
    schedule,
    payload: new SchedulerPayload({
      kind: 'system_event',
      message: id,
      meta: { system_event: id },
    }),
    protected: true,
    purpose: `${name} system job`,
    now,
  })
}
