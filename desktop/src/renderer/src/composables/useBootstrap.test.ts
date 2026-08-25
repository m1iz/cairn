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

  it('keeps a slower previous session bootstrap from replacing the latest one', async () => {
    const resolvers = new Map<string, (payload: unknown) => void>()
    g.window = {
      cairn: {
        invokeCore: async (...args: unknown[]) =>
          await new Promise((resolve) => {
            const request = args[1] as { sessionId: string }
            resolvers.set(request.sessionId, resolve)
          }),
      },
    }
    const bootstrap = useBootstrap(() => {})
    const first = bootstrap.loadBootstrap(false, 'session-1')
    const second = bootstrap.loadBootstrap(false, 'session-2')

    resolvers.get('session-2')?.({ app: 'latest', modelConfig: { models: [] } })
    await expect(second).resolves.toBe(true)
    resolvers.get('session-1')?.({ app: 'stale', modelConfig: { models: [] } })
    await expect(first).resolves.toBe(false)

    expect(bootstrap.boot.value?.app).toBe('latest')
  })
})
