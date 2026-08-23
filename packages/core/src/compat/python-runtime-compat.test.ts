import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { activeEntry, loadModelConfig } from '../config/model-config'
import { MemoryStore } from '../memory/store'
import { loadMcpConfig } from '../mcp/config'
import { ConversationStore } from '../sessions/conversation'
import { SessionStore } from '../sessions/store'
import { MessageBus } from '../team/bus'
import { TeamStore } from '../team/store'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, '..', '..', 'fixtures', 'python-runtime')

describe('Python runtime data compatibility (MIG-REL-003)', () => {
  it('loads Python-layout memory, model_config, mcp_config, sessions, and team data without migration prompts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-python-runtime-'))
    cpSync(fixtureDir, root, { recursive: true })

    const model = await loadModelConfig(root, { create: false })
    expect(activeEntry(model)).toMatchObject({
      displayName: 'Python DeepSeek',
      provider: 'deepseek',
      protocol: 'openai',
      modelId: 'deepseek-chat',
    })
    expect(activeEntry(model)?.entryId).toMatch(/^model-/)
    expect(model.activeModelId).toBe(activeEntry(model)?.entryId)

    const mcp = await loadMcpConfig(root, { PY_TOOL: '/usr/bin/python3' })
    expect(mcp.defaults).toMatchObject({ read_only: true, exclusive: false })
    expect(mcp.servers.legacy_reader).toMatchObject({
      enabled: true,
      transport: 'stdio',
      command: '/usr/bin/python3',
      args: ['-m', 'legacy_reader'],
    })

    const memory = new MemoryStore(
      join(root, 'memory'),
      join(root, 'templates', 'USER.local.md'),
    )
    expect(memory.readMemory()).toContain('Python 版长期记忆')
    expect(
      readFileSync(join(root, 'memory', '2026-06-25.md'), 'utf8'),
    ).toContain('Python 版情景记忆')
    expect(memory.loadUnarchivedHistory().map((row) => row.content)).toEqual([
      '旧会话用户消息',
      '旧会话助手消息',
    ])
    expect(existsSync(join(root, 'memory', 'history_index.json'))).toBe(true)
    expect(
      existsSync(join(root, 'memory', 'history.legacy-backup.jsonl')),
    ).toBe(true)

    const sessions = new SessionStore(root).list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'default',
      title: 'Python 默认会话',
      message_count: 2,
    })
    const conversation = new ConversationStore(
      join(root, 'sessions', 'default'),
    )
    expect(
      conversation.loadUnarchivedHistory().map((row) => row.content),
    ).toEqual(['session user', 'session assistant'])
    expect(
      JSON.parse(
        readFileSync(
          join(root, 'sessions', 'default', '_checkpoint.json'),
          'utf8',
        ),
      ).history[0].content,
    ).toBe('checkpoint user')

    const teamStore = new TeamStore(root)
    expect(teamStore.listMembers()).toHaveLength(1)
    expect(teamStore.getMember('reviewer')?.status).toBe('offline')
    expect(
      teamStore.readThread('reviewer').map((row) => row.content),
    ).toContain('thread context')
    expect(
      new MessageBus(teamStore)
        .recent('lead')
        .map((message) => message.content),
    ).toContain('ready for review')
  })
})
