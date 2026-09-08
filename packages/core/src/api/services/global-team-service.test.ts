import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { GlobalTeamCatalog } from '../../team/catalog'
import { CoreGlobalTeamService } from './global-team-service'

describe('CoreGlobalTeamService', () => {
  it('publishes each completion immediately and does not overwrite cancellation with late results', async () => {
    const catalog = new GlobalTeamCatalog(
      mkdtempSync(join(tmpdir(), 'cairn-team-progress-')),
    )
    let release!: (result: string) => void
    const slow = new Promise<string>((resolve) => {
      release = resolve
    })
    let calls = 0
    const service = new CoreGlobalTeamService({
      catalog,
      availableAgentTypes: () => ['reader'],
      createManager: () =>
        ({
          spawnTeammate: async () => '{}',
          sendMessage: async (input: { content: string }) => {
            expect(input.content).toContain('你在先行阶段')
            calls++
            return JSON.stringify({
              result: calls === 1 ? 'first done' : await slow,
            })
          },
        }) as never,
      synthesize: async () => 'final',
    })
    const created = await service.create({
      name: 'progress',
      members: [
        { display_name: 'first', agent_type: 'reader' },
        { display_name: 'second', agent_type: 'reader' },
      ],
    })
    const team = created.team.id,
      conv = created.conversations[0]!.id
    const run = await service.submit(team, conv, 'task')
    await vi.waitFor(async () => {
      const current = await catalog.getRun(team, conv, run.id)
      expect(current?.assignments.map((item) => item.status)).toEqual([
        'completed',
        'running',
      ])
      expect(current?.assignments.every((item) => item.dispatched)).toBe(true)
    })
    await service.cancel(team, conv, run.id)
    release('Cancelled: stopped')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const cancelled = await catalog.getRun(team, conv, run.id)
    expect(cancelled?.state).toBe('cancelled')
    expect(cancelled?.assignments.map((item) => item.status)).toEqual([
      'completed',
      'cancelled',
    ])
  })
  it('resumes only dispatched members, delivers reviewer evidence, and rejects duplicate admission', async () => {
    const catalog = new GlobalTeamCatalog(
      mkdtempSync(join(tmpdir(), 'cairn-team-resume-review-')),
    )
    const types = new Map<string, string>()
    const sendMessage = vi.fn(
      async (input: { to: string; content: string }) => {
        if (types.get(input.to) === 'verification_reviewer') {
          expect(input.content).toContain('recovered evidence')
          return JSON.stringify({ result: 'review confirmed' })
        }
        return JSON.stringify({
          result: '本轮执行额度已用尽，执行已安全暂停。',
        })
      },
    )
    const wakeTeammate = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return 'recovered evidence'
    })
    const service = new CoreGlobalTeamService({
      catalog,
      availableAgentTypes: () => ['reader', 'verification_reviewer'],
      createManager: () =>
        ({
          spawnTeammate: async (input: {
            name: string
            agent_type: string
          }) => {
            types.set(input.name, input.agent_type)
            return '{}'
          },
          sendMessage,
          wakeTeammate,
        }) as never,
      synthesize: async () => 'final',
    })
    const created = await service.create({
      name: '恢复验收',
      members: [
        { display_name: '读取', agent_type: 'reader' },
        { display_name: '复核', agent_type: 'verification_reviewer' },
      ],
    })
    const team = created.team.id,
      conv = created.conversations[0]!.id
    const admissions = await Promise.allSettled([
      service.submit(team, conv, 'task'),
      service.submit(team, conv, 'duplicate'),
    ])
    expect(admissions.map((item) => item.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ])
    await vi.waitFor(async () =>
      expect((await service.listRuns(team, conv))[0]?.state).toBe(
        'awaiting_user',
      ),
    )
    const run = (await service.listRuns(team, conv))[0]!
    expect(run.assignments[1]?.dispatched).toBe(false)
    await Promise.all([
      service.resume(team, conv, run.id),
      service.resume(team, conv, run.id),
    ])
    await vi.waitFor(async () =>
      expect((await service.listRuns(team, conv))[0]?.state).toBe('completed'),
    )
    expect(wakeTeammate).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('retries incomplete members in a new runtime, preserves successes and reruns review', async () => {
    const catalog = new GlobalTeamCatalog(
      mkdtempSync(join(tmpdir(), 'cairn-team-retry-')),
    )
    const types = new Map<string, string>()
    const calls: string[] = [],
      roots: string[] = []
    let fail = true
    const service = new CoreGlobalTeamService({
      catalog,
      availableAgentTypes: () => ['reader', 'coder', 'verification_reviewer'],
      createManager: (opts) => {
        roots.push(opts.runtimeRoot)
        return {
          spawnTeammate: async (input: {
            name: string
            agent_type: string
          }) => {
            types.set(input.name, input.agent_type)
            return '{}'
          },
          sendMessage: async (input: { to: string }) => {
            const type = types.get(input.to)!
            calls.push(type)
            return JSON.stringify({
              result:
                type === 'coder' && fail
                  ? 'Error: temporary failure'
                  : `evidence ${type}`,
            })
          },
        } as never
      },
      synthesize: async () => 'answer',
    })
    const created = await service.create({
      name: 'retry',
      members: ['reader', 'coder', 'verification_reviewer'].map((type) => ({
        display_name: type,
        agent_type: type,
      })),
    })
    const team = created.team.id,
      conv = created.conversations[0]!.id
    await service.submit(team, conv, 'task')
    await vi.waitFor(async () =>
      expect((await service.listRuns(team, conv))[0]?.state).toBe('partial'),
    )
    const first = (await service.listRuns(team, conv))[0]!
    fail = false
    const retried = await service.retry(team, conv, first.id)
    await vi.waitFor(async () =>
      expect((await catalog.getRun(team, conv, retried.id))?.state).toBe(
        'completed',
      ),
    )
    expect(calls).toEqual([
      'reader',
      'coder',
      'verification_reviewer',
      'coder',
      'verification_reviewer',
    ])
    expect(roots[1]).not.toBe(roots[0])
    expect((await catalog.getRun(team, conv, first.id))?.state).toBe('partial')
  })

  it.each(['', '没有未读消息。'])(
    'does not report an empty result as success: %s',
    async (result) => {
      const catalog = new GlobalTeamCatalog(
        mkdtempSync(join(tmpdir(), 'cairn-team-empty-')),
      )
      const synthesize = vi.fn(async () => 'should not run')
      const service = new CoreGlobalTeamService({
        catalog,
        availableAgentTypes: () => ['reader'],
        createManager: () =>
          ({
            spawnTeammate: async () => '{}',
            sendMessage: async () => JSON.stringify({ result }),
          }) as never,
        synthesize,
      })
      const created = await service.create({
        name: 'empty',
        members: [{ display_name: 'reader', agent_type: 'reader' }],
      })
      await service.submit(
        created.team.id,
        created.conversations[0]!.id,
        'task',
      )
      await vi.waitFor(async () =>
        expect(
          (
            await service.listRuns(
              created.team.id,
              created.conversations[0]!.id,
            )
          )[0]?.state,
        ).toBe('failed'),
      )
      expect(synthesize).not.toHaveBeenCalled()
    },
  )
  it('manages global Teams without consulting an active project session', async () => {
    const catalog = new GlobalTeamCatalog(
      mkdtempSync(join(tmpdir(), 'cairn-global-team-service-')),
    )
    const assertMutation = vi.fn()
    const service = new CoreGlobalTeamService({
      catalog,
      availableAgentTypes: () => ['reader', 'coder'],
      assertMutation,
    })

    const created = await service.create({
      name: '独立团队',
      members: [
        { display_name: '阅读', agent_type: 'reader' },
        { display_name: '实现', agent_type: 'coder' },
      ],
    })
    const second = await service.createConversation(created.team.id, {
      title: '第二次任务',
    })

    expect((await service.list())[0]).toMatchObject({
      id: created.team.id,
      conversation_count: 2,
      latest_conversation: { id: second.id },
    })
    expect((await service.get(created.team.id)).conversations).toHaveLength(2)
    expect(assertMutation.mock.calls).toEqual([
      ['teams', 'create global team'],
      ['teams', 'create team conversation'],
    ])
  })

  it('rejects an unavailable base agent before writing Team state', async () => {
    const catalog = new GlobalTeamCatalog(
      mkdtempSync(join(tmpdir(), 'cairn-global-team-service-role-')),
    )
    const service = new CoreGlobalTeamService({
      catalog,
      availableAgentTypes: () => ['reader'],
    })

    await expect(
      service.create({
        name: '无效团队',
        members: [{ display_name: '实现', agent_type: 'coder' }],
      }),
    ).rejects.toThrow('unknown Team base agent type: coder')
    expect(await catalog.listTeams()).toEqual([])
  })

  it('runs isolated members and persists the coordinator response', async () => {
    const catalog = new GlobalTeamCatalog(
      mkdtempSync(join(tmpdir(), 'cairn-global-team-service-run-')),
    )
    const sendMessage = vi.fn(async ({ to }: { to: string }) =>
      JSON.stringify({ result: `result:${to}` }),
    )
    const spawnTeammate = vi.fn(async () => '{}')
    const service = new CoreGlobalTeamService({
      catalog,
      availableAgentTypes: () => ['reader', 'reviewer'],
      createManager: () => ({ sendMessage, spawnTeammate }) as never,
      synthesize: async () => '最终答案',
    })
    const created = await service.create({
      name: '执行团队',
      members: [
        { display_name: '阅读', agent_type: 'reader' },
        { display_name: '复核', agent_type: 'reviewer' },
      ],
    })
    const conversation = created.conversations[0]!
    await service.submit(created.team.id, conversation.id, '真实任务')
    await vi.waitFor(async () => {
      expect(
        (await service.listRuns(created.team.id, conversation.id))[0]?.state,
      ).toBe('completed')
    })
    const run = (await service.listRuns(created.team.id, conversation.id))[0]!
    expect(run.final_response).toBe('最终答案')
    expect(run.assignments.map((item) => item.status)).toEqual([
      'completed',
      'completed',
    ])
    expect(spawnTeammate).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('keeps successful member evidence when coordinator synthesis fails', async () => {
    const catalog = new GlobalTeamCatalog(
      mkdtempSync(join(tmpdir(), 'cairn-global-team-service-partial-')),
    )
    const service = new CoreGlobalTeamService({
      catalog,
      availableAgentTypes: () => ['reader'],
      createManager: () =>
        ({
          spawnTeammate: async () => '{}',
          sendMessage: async () =>
            JSON.stringify({ result: '可验证的成员结果' }),
        }) as never,
      synthesize: async () => {
        throw new Error('provider unavailable')
      },
    })
    const created = await service.create({
      name: '降级团队',
      members: [{ display_name: '阅读', agent_type: 'reader' }],
    })
    const conversation = created.conversations[0]!
    await service.submit(created.team.id, conversation.id, '检查')
    await vi.waitFor(async () => {
      const latest = (
        await service.listRuns(created.team.id, conversation.id)
      )[0]!
      expect(latest.state, latest.error).toBe('partial')
    })
    const run = (await service.listRuns(created.team.id, conversation.id))[0]!
    expect(run.final_response).toContain('可验证的成员结果')
    expect(run.error).toContain('provider unavailable')
  })

  it('bounds member concurrency, passes a control session, and runs reviewers after primary evidence', async () => {
    const catalog = new GlobalTeamCatalog(
      mkdtempSync(join(tmpdir(), 'cairn-global-team-service-phases-')),
    )
    const types = new Map<string, string>()
    const calls: Array<{ type: string; content: string; sessionId: string }> =
      []
    let active = 0
    let maxActive = 0
    let primaryFinished = 0
    const service = new CoreGlobalTeamService({
      catalog,
      availableAgentTypes: () => ['reader', 'coder', 'verification_reviewer'],
      createManager: () =>
        ({
          spawnTeammate: async (input: {
            name: string
            agent_type: string
          }) => {
            types.set(input.name, input.agent_type)
            return '{}'
          },
          sendMessage: async (input: {
            to: string
            content: string
            session_id?: string | null
          }) => {
            const type = types.get(input.to) ?? ''
            calls.push({
              type,
              content: input.content,
              sessionId: input.session_id ?? '',
            })
            if (type === 'verification_reviewer')
              expect(primaryFinished).toBe(2)
            active += 1
            maxActive = Math.max(maxActive, active)
            await new Promise((resolve) => setTimeout(resolve, 10))
            active -= 1
            if (type !== 'verification_reviewer') primaryFinished += 1
            const result =
              type === 'coder'
                ? 'Error: simulated implementation failure'
                : type === 'verification_reviewer'
                  ? 'reviewed primary evidence'
                  : 'reader evidence'
            return JSON.stringify({ result })
          },
        }) as never,
      synthesize: async () => 'partial answer',
    })
    const created = await service.create({
      name: '分阶段团队',
      members: [
        { display_name: '阅读', agent_type: 'reader' },
        { display_name: '实现', agent_type: 'coder' },
        { display_name: '复核', agent_type: 'verification_reviewer' },
      ],
    })
    const conversation = created.conversations[0]!
    await service.submit(created.team.id, conversation.id, '检查实现')
    await vi.waitFor(async () => {
      const latest = (
        await service.listRuns(created.team.id, conversation.id)
      )[0]!
      expect(latest.state, latest.error).toBe('partial')
    })

    const run = (await service.listRuns(created.team.id, conversation.id))[0]!
    expect(maxActive).toBe(2)
    expect(run.assignments.map((item) => item.status)).toEqual([
      'completed',
      'failed',
      'completed',
    ])
    expect(run.assignments[1]?.error).toContain(
      'simulated implementation failure',
    )
    expect(
      calls.every(
        (call) => call.sessionId === `global-team:${conversation.id}`,
      ),
    ).toBe(true)
    const reviewer = calls.find(
      (call) => call.type === 'verification_reviewer',
    )!
    expect(reviewer.content).toContain('reader evidence')
    expect(reviewer.content).toContain('simulated implementation failure')
  })

  it('keeps an exhausted member pending and resumes it with the Team control session', async () => {
    const catalog = new GlobalTeamCatalog(
      mkdtempSync(join(tmpdir(), 'cairn-global-team-service-resume-')),
    )
    const wakeTeammate = vi.fn(async () => 'resumed result')
    const service = new CoreGlobalTeamService({
      catalog,
      availableAgentTypes: () => ['reader'],
      createManager: () =>
        ({
          spawnTeammate: async () => '{}',
          sendMessage: async () =>
            JSON.stringify({
              result: '本轮执行额度已用尽，执行已安全暂停。',
            }),
          wakeTeammate,
        }) as never,
      synthesize: async () => 'resumed answer',
    })
    const created = await service.create({
      name: '续跑团队',
      members: [{ display_name: '阅读', agent_type: 'reader' }],
    })
    const conversation = created.conversations[0]!
    const submitted = await service.submit(
      created.team.id,
      conversation.id,
      '长任务',
    )
    await vi.waitFor(async () => {
      const latest = (
        await service.listRuns(created.team.id, conversation.id)
      )[0]!
      expect(latest.state, latest.error).toBe('awaiting_user')
    })
    const paused = (
      await service.listRuns(created.team.id, conversation.id)
    )[0]!
    expect(paused.assignments[0]?.status).toBe('pending')

    await service.resume(created.team.id, conversation.id, submitted.id)
    await vi.waitFor(async () => {
      expect(
        (await service.listRuns(created.team.id, conversation.id))[0]?.state,
      ).toBe('completed')
    })
    expect(wakeTeammate).toHaveBeenCalledWith(
      paused.members[0]?.id,
      expect.objectContaining({
        recovery: 'retry',
        session_id: `global-team:${conversation.id}`,
      }),
    )
  })
})
