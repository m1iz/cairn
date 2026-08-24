import { describe, expect, it, vi } from 'vitest'
import type { CoreApi } from './core-api'
import { CoreOperationArgumentsError } from './operations'
import { CORE_OPERATION_COMPATIBILITY } from './compatibility-manifest'
import { createCoreOperationDispatcher } from './core-operation-dispatcher'

describe('Core operation dispatcher', () => {
  it('registers the full compatibility surface and preserves validation', async () => {
    const rename = vi.fn(async (id: string, input: { title: string }) => ({
      id,
      title: input.title,
    }))
    const api = {
      loop: { lifecycleSupervisor: { assertReady: vi.fn() } },
      sessions: { rename },
    } as unknown as CoreApi
    const dispatcher = createCoreOperationDispatcher(api)

    expect(dispatcher.operations()).toHaveLength(
      CORE_OPERATION_COMPATIBILITY.count,
    )
    await expect(
      dispatcher.dispatch('sessions.rename', ['s1', { title: 'Cairn' }]),
    ).resolves.toEqual({ id: 's1', title: 'Cairn' })
    expect(rename).toHaveBeenCalledOnce()
    await expect(
      dispatcher.dispatch('sessions.rename', ['s1']),
    ).rejects.toBeInstanceOf(CoreOperationArgumentsError)
  })
})
