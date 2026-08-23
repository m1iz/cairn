import { describe, expect, it } from 'vitest'

describe('schedulerMessageMeta', () => {
  it('parses scheduler trigger display names', async () => {
    const { schedulerMessageMeta } = await import('./schedulerMeta')

    expect(
      schedulerMessageMeta(
        '定时任务触发 · 日报\n\n生成摘要',
        'scheduler:job:turn',
      ),
    ).toEqual({
      source: 'scheduler',
      scheduler: { jobName: '日报' },
    })
  })

  it('preserves explicit non-scheduler source only', async () => {
    const { schedulerMessageMeta } = await import('./schedulerMeta')

    expect(schedulerMessageMeta('hello', '', 'external')).toEqual({
      source: 'external',
    })
  })
})
