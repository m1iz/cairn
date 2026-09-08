import { describe, expect, it, vi } from 'vitest'
import type { CoreGlobalTeamDetail, CoreGlobalTeamListItem } from '@cairn/core'
import { createGlobalTeamsStore } from './useGlobalTeams'

function team(id: string, updatedAt: number): CoreGlobalTeamListItem {
  return {
    version: 1,
    id,
    name: id,
    description: '',
    default_workspace: { kind: 'none' },
    members: [],
    created_at: updatedAt,
    updated_at: updatedAt,
    archived_at: null,
    revision: 1,
    latest_conversation: null,
    conversation_count: 0,
  }
}

describe('createGlobalTeamsStore', () => {
  it('deduplicates concurrent list loads and refreshes after create', async () => {
    const first = [team('team_111111111111111111111111', 1)]
    const second = [team('team_222222222222222222222222', 2)]
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({
        team: second[0],
        conversations: [],
      } satisfies CoreGlobalTeamDetail)
      .mockResolvedValueOnce(second)
    const store = createGlobalTeamsStore(invoke as never)

    const [left, right] = await Promise.all([store.load(), store.load()])
    expect(left).toEqual(first)
    expect(right).toEqual(first)
    expect(invoke).toHaveBeenCalledTimes(1)

    await store.create({
      name: '新团队',
      members: [{ display_name: 'Reader', agent_type: 'reader' }],
    })
    expect(store.teams.value).toEqual(second)
    expect(store.loaded.value).toBe(true)
  })

  it('preserves the last list while exposing a readable refresh error', async () => {
    const existing = [team('team_111111111111111111111111', 1)]
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(existing)
      .mockRejectedValueOnce(new Error('Core unavailable'))
    const store = createGlobalTeamsStore(invoke as never)

    await store.load()
    await expect(store.load(true)).rejects.toThrow('Core unavailable')
    expect(store.teams.value).toEqual(existing)
    expect(store.error.value).toBe('Core unavailable')
  })
})
