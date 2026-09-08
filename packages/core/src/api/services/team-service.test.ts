import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Tool } from '../../tools/base'
import { ToolRegistry } from '../../tools/registry'
import { toolParamsSchema } from '../../tools/schema'
import { TeamManager } from '../../team/manager'
import { LEAD_ACTOR } from '../../team/models'
import { CoreTeamService } from './team-service'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('CoreTeamService', () => {
  it('wraps TeamManager payload with managed project scope and member detail', async () => {
    const manager = makeManager(tmp('cairn-team-service-'))
    const service = new CoreTeamService({
      teamManager: manager,
      activeSession: () => ({ mode: 'build', project_id: 'proj_123' }),
    })

    const created = await service.spawnMember({ name: 'alice', role: 'reader' })
    await service.sendMessage({
      to: 'alice',
      content: 'read docs',
      wake: false,
    })
    manager.store.writeThread('alice', [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(2100) }] },
    ])

    const payload = service.get()
    const detail = service.getMember('alice')

    expect(
      created.team.members.some((member: any) => member.name === 'alice'),
    ).toBe(true)
    expect(payload).toMatchObject({
      managed: true,
      scope: 'project',
      project_id: 'proj_123',
      leadUnread: 0,
    })
    expect(detail.member).toMatchObject({
      name: 'alice',
      unread: 1,
      tools: ['echo', 'send_message', 'read_inbox'],
    })
    expect(detail.activeRun).toBeNull()
    expect(detail.inbox[0]).toMatchObject({
      from: LEAD_ACTOR,
      to: 'alice',
      content: 'read docs',
    })
    expect(detail.thread[0]!.content).toHaveLength(2000)
  })

  it('returns chat fallback when no team manager exists', () => {
    const service = new CoreTeamService({ teamManager: null })

    expect(service.get()).toEqual({
      managed: true,
      scope: 'chat',
      project_id: null,
      config: { team_name: 'none', members: [] },
      members: [],
      available_agent_types: [],
      available_agent_profiles: [],
      leadUnread: 0,
      leadInbox: [],
    })
    expect(() => service.getMember('alice')).toThrow(
      'Team is only available inside Build project sessions',
    )
  })

  it('applies mutation checks and returns {result, team} for write operations', async () => {
    const calls: string[] = []
    const manager = makeManager(tmp('cairn-team-service-write-'))
    const service = new CoreTeamService({
      teamManager: manager,
      assertMutation: (area, action) => {
        calls.push(`${area}:${action}`)
      },
    })

    const spawned = await service.spawnMember({ name: 'bob', role: 'reader' })
    const sent = await service.sendMessage({
      to: 'bob',
      content: 'hello',
      wake: false,
    })
    const woken = await service.wakeMember('bob')
    const cancelled = service.cancelRun('bob', 'no longer needed')
    const shutdown = await service.shutdownMember('bob')

    expect(spawned.result).toContain('"created"')
    expect(sent.result).toContain('"message"')
    expect(woken.result).toBe('handled by bob')
    expect(cancelled.result).toContain('"cancelled":false')
    expect(shutdown.result).toContain('"shutdown"')
    expect(
      shutdown.team.members.find((member: any) => member.name === 'bob')
        ?.status,
    ).toBe('shutdown')
    expect(calls).toEqual([
      'team:spawn teammate',
      'team:send message',
      'team:wake teammate',
      'team:cancel teammate run',
      'team:shutdown teammate',
    ])
  })

  it('accepts a desktop task before its background teammate run completes', async () => {
    let finish!: (value: string) => void
    const runnerDone = new Promise<string>((resolve) => {
      finish = resolve
    })
    const manager = makeManager(tmp('cairn-team-service-background-'), () =>
      runnerDone.then(() => 'background result'),
    )
    const service = new CoreTeamService({ teamManager: manager })
    await service.spawnMember({ name: 'alice', role: 'reader' })

    const accepted = await service.sendMessage({
      to: 'alice',
      content: 'inspect state',
      wake: true,
      background: true,
    })

    expect(accepted.result).toContain('inspect state')
    expect(manager.store.getMember('alice')?.status).toBe('working')
    finish('done')
    await vi.waitFor(() => {
      expect(manager.store.getMember('alice')?.status).toBe('idle')
    })
    expect(manager.bus.recent('lead', { limit: 1 })[0]?.content).toBe(
      'background result',
    )
  })

  it('surfaces an unexpected background wake failure on the teammate', async () => {
    const manager = makeManager(tmp('cairn-team-service-wake-error-'))
    const service = new CoreTeamService({ teamManager: manager })
    await service.spawnMember({ name: 'alice', role: 'reader' })
    vi.spyOn(manager, 'wakeTeammate').mockRejectedValueOnce(
      new Error('scheduler unavailable'),
    )

    await service.sendMessage({
      to: 'alice',
      content: 'inspect state',
      wake: true,
      background: true,
    })

    await vi.waitFor(() => {
      expect(manager.store.getMember('alice')).toMatchObject({
        status: 'error',
        last_error: 'Background wake failed: scheduler unavailable',
      })
    })
  })
})

class EchoTool extends Tool {
  override name = 'echo'
  override description = 'echo'
  override parameters = toolParamsSchema({})
  override readOnly = true
  execute(): string {
    return 'echo'
  }
}

function makeManager(
  root: string,
  run: (memberName: string) => string | Promise<string> = (memberName) =>
    `handled by ${memberName}`,
): TeamManager {
  const parentRegistry = new ToolRegistry()
  parentRegistry.register(new EchoTool())
  return new TeamManager({
    root,
    parentRegistry,
    subagentRegistry: {
      get: (name: string) =>
        name === 'code_explorer' ? { name, tool_names: ['echo'] } : null,
      resolveName: (name: string) => name,
      names: () => ['code_explorer'],
    },
    runnerFactory: ({ member }) => ({
      step: () => run(member.name),
    }),
  })
}
