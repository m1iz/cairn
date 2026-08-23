import type { SchedulerMessageMeta } from '../types'

export const SCHEDULER_CLIENT_ID_PREFIX = 'scheduler:'
export const SCHEDULER_TRIGGER_PREFIXES = ['定时任务触发 ·', '司时台触发 ·']

export function schedulerTriggerPrefix(content: string) {
  const text = content.trimStart()
  return (
    SCHEDULER_TRIGGER_PREFIXES.find((prefix) => text.startsWith(prefix)) || ''
  )
}

export function schedulerMessageMeta(
  content: string,
  clientId = '',
  source?: string,
  scheduler?: SchedulerMessageMeta,
): { source?: string; scheduler?: SchedulerMessageMeta } {
  const displayPrefix = schedulerTriggerPrefix(content)
  const isScheduler =
    source === 'scheduler' ||
    clientId.startsWith(SCHEDULER_CLIENT_ID_PREFIX) ||
    Boolean(displayPrefix)
  if (!isScheduler) return source ? { source } : {}

  const meta: SchedulerMessageMeta = { ...(scheduler || {}) }
  if (!meta.jobName) {
    const firstLine = content.trimStart().split(/\r?\n/, 1)[0] || ''
    const parsedName =
      displayPrefix && firstLine.startsWith(displayPrefix)
        ? firstLine.slice(displayPrefix.length).trim()
        : ''
    if (parsedName) meta.jobName = parsedName
  }
  return {
    source: 'scheduler',
    scheduler: Object.keys(meta).length ? meta : undefined,
  }
}
