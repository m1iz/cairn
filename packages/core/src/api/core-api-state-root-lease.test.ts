import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentLoop } from '../agent/loop'
import { CoreApi } from './core-api'

afterEach(() => vi.restoreAllMocks())

describe('CoreApi state root lease lifecycle', () => {
  it('releases the process lease when AgentLoop startup fails', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'cairn-core-lease-failure-'))
    vi.spyOn(AgentLoop, 'create').mockRejectedValueOnce(
      new Error('injected startup failure'),
    )

    await expect(
      CoreApi.create({ root: stateRoot, stateRoot, hostKind: 'desktop' }),
    ).rejects.toThrow('injected startup failure')
    expect(existsSync(join(stateRoot, '.state-root.lease'))).toBe(false)
  })
})
