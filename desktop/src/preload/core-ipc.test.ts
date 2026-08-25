import { describe, expect, it } from 'vitest'
import { createCoreBridge, type CoreBridge } from './core-ipc'

describe('preload core IPC bridge', () => {
  it('invokes namespaced CoreApi channels by operation key', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const bridge = createCoreBridge({
      invoke: async (channel, ...args) => {
        calls.push({ channel, args })
        return { ok: true }
      },
    })

    await expect(
      bridge.invokeCore('sessions.create', { title: 'A' }),
    ).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      { channel: 'cairn:core:sessions:create', args: [{ title: 'A' }] },
    ])
  })
})

declare const typedBridge: CoreBridge

function _assertCoreBridgeTypes(): void {
  void typedBridge.invokeCore('sessions.rename', 's1', { title: 'Typed' })

  // @ts-expect-error operation keys are closed
  void typedBridge.invokeCore('missing.operation')

  // @ts-expect-error sessions.rename requires its patch argument
  void typedBridge.invokeCore('sessions.rename', 's1')

  void typedBridge.invokeCore('environment.getStatus', { forceRefresh: true })
  void typedBridge.invokeCore('environment.createInstallPlan', {
    toolIds: ['git', 'node'],
  })

  void typedBridge.invokeCore('environment.install', {
    planId: 'plan_1',
    acceptedLicenseIds: [],
    confirmedStepIds: [],
    // @ts-expect-error renderer cannot submit executable commands
    command: 'curl evil',
  })
}
