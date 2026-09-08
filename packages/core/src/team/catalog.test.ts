import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GlobalTeamCatalog } from './catalog'

describe('GlobalTeamCatalog', () => {
  it('creates a global team and an independent first conversation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-global-team-'))
    const catalog = new GlobalTeamCatalog(root)

    const created = await catalog.createTeam({
      name: '前端质量团队',
      description: '实现、审查与测试',
      members: [
        {
          display_name: '界面实现',
          agent_type: 'coder',
          responsibility: '负责实现确认后的界面改动',
        },
        { display_name: '代码审查', agent_type: 'reviewer' },
      ],
    })

    expect(created.team.id).toMatch(/^team_/)
    expect(created.conversation.team_id).toBe(created.team.id)
    expect(created.team.default_workspace).toEqual({ kind: 'none' })
    expect((await catalog.listTeams()).map((team) => team.name)).toEqual([
      '前端质量团队',
    ])
    expect(await catalog.listConversations(created.team.id)).toEqual([
      created.conversation,
    ])
  })

  it('creates later conversations without duplicating or mutating members', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-global-team-conv-'))
    const catalog = new GlobalTeamCatalog(root)
    const { team, conversation: first } = await catalog.createTeam({
      name: '研究团队',
      default_workspace: { kind: 'folder', path: 'D:\\research' },
      members: [{ display_name: '研究员', agent_type: 'researcher' }],
    })

    const second = await catalog.createConversation(team.id, {
      title: '新问题',
      workspace: { kind: 'none' },
    })
    const storedTeam = await catalog.getTeam(team.id)
    const conversations = await catalog.listConversations(team.id)

    expect(second.id).not.toBe(first.id)
    expect(second.workspace).toEqual({ kind: 'none' })
    expect(storedTeam?.members).toEqual(team.members)
    expect(storedTeam?.revision).toBe(2)
    expect(conversations.map((item) => item.id).sort()).toEqual(
      [first.id, second.id].sort(),
    )
  })

  it('rejects duplicate display names and isolates corrupt team records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-global-team-invalid-'))
    const catalog = new GlobalTeamCatalog(root)
    await expect(
      catalog.createTeam({
        name: '重复成员',
        members: [
          { display_name: 'Coder', agent_type: 'coder' },
          { display_name: 'coder', agent_type: 'reviewer' },
        ],
      }),
    ).rejects.toThrow('duplicate team member display name')

    const created = await catalog.createTeam({
      name: '损坏隔离',
      members: [{ display_name: 'Reader', agent_type: 'reader' }],
    })
    const teamFile = join(
      root,
      'global-v1',
      'teams',
      created.team.id,
      'team.json',
    )
    writeFileSync(teamFile, '{', 'utf8')

    expect(await catalog.listTeams()).toEqual([])
    expect(
      readFileSync(
        join(
          root,
          'global-v1',
          'teams',
          created.team.id,
          'conversations',
          `${created.conversation.id}.json`,
        ),
        'utf8',
      ),
    ).toContain(created.conversation.id)
  })

  it('persists immutable run snapshots and enforces run transitions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-global-team-run-'))
    const catalog = new GlobalTeamCatalog(root)
    const { team, conversation } = await catalog.createTeam({
      name: '运行团队',
      members: [{ display_name: 'Reader', agent_type: 'reader' }],
    })
    const run = await catalog.createRun(team.id, conversation.id, '检查项目')
    expect(run.members).toEqual([
      expect.objectContaining({ display_name: 'Reader', agent_type: 'reader' }),
    ])
    const planning = await catalog.updateRun(
      team.id,
      conversation.id,
      run.id,
      (current) => ({
        ...current,
        state: 'planning',
        started_at: 10,
      }),
    )
    expect(planning.revision).toBe(2)
    await expect(
      catalog.updateRun(team.id, conversation.id, run.id, (current) => ({
        ...current,
        state: 'completed',
        finished_at: 11,
      })),
    ).rejects.toThrow('invalid team run transition')
  })
})
