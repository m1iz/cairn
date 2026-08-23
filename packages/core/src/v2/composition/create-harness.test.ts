import { describe, expect, it } from 'vitest'
import { createHarness } from './create-harness'

describe('createHarness', () => {
  it('runs one command and one query through the v2 composition root', async () => {
    const ticks = [100, 250]
    const harness = createHarness({
      clock: { now: () => ticks.shift() ?? 250 },
    })

    await expect(harness.status()).resolves.toEqual({
      lifecycle: 'created',
      startedAt: null,
      closedAt: null,
    })
    await expect(harness.start()).resolves.toEqual({
      lifecycle: 'running',
      startedAt: 100,
      closedAt: null,
    })
    await expect(harness.status()).resolves.toEqual({
      lifecycle: 'running',
      startedAt: 100,
      closedAt: null,
    })
    await expect(harness.close()).resolves.toEqual({
      lifecycle: 'closed',
      startedAt: 100,
      closedAt: 250,
    })
  })

  it('is idempotent for repeated start and close and rejects restart', async () => {
    let now = 10
    const harness = createHarness({ clock: { now: () => now++ } })

    const started = await harness.start()
    expect(await harness.start()).toEqual(started)
    const closed = await harness.close()
    expect(await harness.close()).toEqual(closed)
    await expect(harness.start()).rejects.toThrow(
      'closed harness cannot restart',
    )
  })
})
