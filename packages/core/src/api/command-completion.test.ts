import { describe, expect, it, vi } from 'vitest'
import {
  completeCoreCommand,
  type CoreCommandCompletionDeps,
} from './command-completion'

function deps(): CoreCommandCompletionDeps {
  return {
    getModelConfig: vi.fn(async () => ({
      models: [
        {
          entryId: 'primary',
          modelId: 'cairn-main',
          effectiveDisplayName: 'Cairn Main',
          provider: 'openai',
        },
      ],
      current: {
        entryId: 'primary',
        reasoningEfforts: ['low', 'high'],
      },
    })),
    listSessions: () => [
      { id: 'session-1', title: 'Project Alpha', preview: 'recent work' },
    ],
    listSkills: () => [
      {
        name: 'review',
        description: 'Review changes',
        status: 'active',
      },
    ],
    listTools: () => [
      {
        name: 'read_file',
        description: 'Read a file',
        source: 'builtin',
      },
    ],
    searchWorkspace: vi.fn(async () => ({
      entries: [{ path: 'src/main.ts', name: 'main.ts', kind: 'file' }],
    })),
  }
}

describe('completeCoreCommand', () => {
  it('projects model, effort, session, skill, and tool suggestions', async () => {
    const sources = deps()
    await expect(
      completeCoreCommand('model', 'main', 'session-1', sources),
    ).resolves.toEqual([
      expect.objectContaining({ value: 'primary', kind: 'model' }),
    ])
    await expect(
      completeCoreCommand('effort', 'hi', 'session-1', sources),
    ).resolves.toEqual([
      { value: 'high', label: 'high', kind: 'reasoning_effort' },
    ])
    await expect(
      completeCoreCommand('resume', 'alpha', 'session-1', sources),
    ).resolves.toEqual([
      expect.objectContaining({ value: 'session-1', kind: 'session' }),
    ])
    await expect(
      completeCoreCommand('skills', 'review', 'session-1', sources),
    ).resolves.toEqual([
      expect.objectContaining({ value: 'review', kind: 'skill' }),
    ])
    await expect(
      completeCoreCommand('tools', 'read', 'session-1', sources),
    ).resolves.toEqual([
      expect.objectContaining({ value: 'read_file', kind: 'tool' }),
    ])
  })

  it('searches workspace-backed completions and degrades search failures', async () => {
    const sources = deps()
    await expect(
      completeCoreCommand('files', 'main', 'session-1', sources),
    ).resolves.toEqual([
      expect.objectContaining({ value: 'src/main.ts', kind: 'file' }),
    ])
    sources.searchWorkspace = vi.fn(async () => {
      throw new Error('unavailable')
    })
    await expect(
      completeCoreCommand('diff', 'main', 'session-1', sources),
    ).resolves.toEqual([])
  })
})
