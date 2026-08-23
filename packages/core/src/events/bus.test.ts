import { describe, expect, it, vi } from 'vitest'
import { EventBus } from './bus'

type Events = {
  ping: { n: number }
  done: { ok: boolean }
}

describe('EventBus', () => {
  it('delivers to typed subscribers and supports unsubscribe', () => {
    const bus = new EventBus<Events>()
    const seen: number[] = []
    const off = bus.on('ping', (p) => seen.push(p.n))
    bus.emit('ping', { n: 1 })
    bus.emit('ping', { n: 2 })
    off()
    bus.emit('ping', { n: 3 })
    expect(seen).toEqual([1, 2])
  })

  it('once fires a single time', () => {
    const bus = new EventBus<Events>()
    const fn = vi.fn()
    bus.once('done', fn)
    bus.emit('done', { ok: true })
    bus.emit('done', { ok: false })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('onAny observes every event with its name (event-bridge use)', () => {
    const bus = new EventBus<Events>()
    const seen: Array<keyof Events> = []
    bus.onAny((name) => seen.push(name))
    bus.emit('ping', { n: 1 })
    bus.emit('done', { ok: true })
    expect(seen).toEqual(['ping', 'done'])
  })
})
