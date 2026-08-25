import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBootstrap } from './useBootstrap'

const g = globalThis as unknown as { window?: unknown; fetch?: unknown }

afterEach(() => {
  delete g.window
  vi.restoreAllMocks()
})

describe('useBootstrap IPC bootstrap', () => {
  it('loads bootstrap through Core IPC when the preload bridge is available', async () => {
    const calls: unknown[][] = []
    g.window = {
      cairn: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          return {
            app: 'Cairn',
            modelConfig: {
              schemaVersion: 2,
              activeModelId: 'entry-1',
              models: [],
              current: { entryId: 'entry-1', provider: 'fake' },
            },
          }
        },
      },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const boot = useBootstrap(() => {})

    await boot.loadBootstrap(true, 'session-1')

    expect(calls).toEqual([['bootstrap', { sessionId: 'session-1' }]])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(boot.boot.value?.app).toBe('Cairn')
    expect(boot.boot.value?.modelConfig.activeModelId).toBe('entry-1')
  })

  it('does not expose the retired whole-config model mutation adapter', async () => {
    const calls: unknown[][] = []
    g.window = {
      cairn: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          if (args[0] === 'bootstrap') {
            return {
              app: 'Cairn',
              modelConfig: { models: [] },
              profileOnboarding: {
                status: 'pending',
                sessionId: null,
                interactionId: null,
                attemptCount: 0,
                lastError: null,
                canStart: true,
                canSkip: true,
              },
            }
          }
          throw new Error(`unexpected operation: ${String(args[0])}`)
        },
      },
    }
    const boot = useBootstrap(() => {})
    await boot.loadBootstrap()

    expect('saveModelConfig' in boot).toBe(false)
    expect(calls).toEqual([['bootstrap', { sessionId: null }]])
  })
})
