import { describe, expect, it } from 'vitest'
import { CORE_EVENT_CHANNEL } from '../shared/ipc-contract'
import { CoreEventBridge } from './event-bridge'

describe('CoreEventBridge (MIG-IPC-003)', () => {
  it('broadcasts core runtime events to attached renderer windows', () => {
    const bridge = new CoreEventBridge()
    const first = new FakeWebContents()
    const second = new FakeWebContents()

    bridge.attach(first)
    bridge.attach(second)
    bridge.emit({ event: 'message_delta', delta: 'hi' })

    expect(first.sent).toEqual([
      [CORE_EVENT_CHANNEL, { event: 'message_delta', delta: 'hi' }],
    ])
    expect(second.sent).toEqual([
      [CORE_EVENT_CHANNEL, { event: 'message_delta', delta: 'hi' }],
    ])
  })

  it('skips destroyed windows and supports detach', () => {
    const bridge = new CoreEventBridge()
    const live = new FakeWebContents()
    const destroyed = new FakeWebContents(true)
    bridge.attach(live)
    bridge.attach(destroyed)

    bridge.detach(live)
    bridge.emit({ event: 'ready' })

    expect(live.sent).toEqual([])
    expect(destroyed.sent).toEqual([])
    expect(bridge.size()).toBe(0)
  })
})

class FakeWebContents {
  readonly sent: unknown[][] = []
  constructor(private readonly destroyed = false) {}
  isDestroyed(): boolean {
    return this.destroyed
  }
  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload])
  }
}
