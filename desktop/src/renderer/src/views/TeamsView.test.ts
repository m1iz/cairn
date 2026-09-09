// @vitest-environment jsdom
import { createApp, nextTick, reactive, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TeamsView from './TeamsView.vue'

const mocks = vi.hoisted(() => ({
  route: null as unknown,
  replace: vi.fn(),
  get: vi.fn(),
  listRuns: vi.fn(),
}))
vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
}))
vi.mock('../api/http', () => ({
  core: vi.fn(async (op: string) =>
    op === 'agentDefinitions.get' ? { availableBaseAgents: [] } : [],
  ),
}))
vi.mock('../composables/useGlobalTeams', () => ({
  useGlobalTeams: () => ({
    teams: ref([
      { id: 'team_test', name: 'test', members: [], conversation_count: 1 },
    ]),
    load: async () => {},
    get: mocks.get,
    listRuns: mocks.listRuns,
  }),
}))

let unmount: (() => void) | undefined
afterEach(() => {
  unmount?.()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('TeamsView route lifecycle', () => {
  it('does not redirect back to Team or apply a stale detail after leaving', async () => {
    const route = reactive({
      name: 'teams',
      params: { teamId: 'team_test', conversationId: 'conv_test' },
    })
    mocks.route = route
    let finish!: (value: unknown) => void
    mocks.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    mocks.listRuns.mockResolvedValue([])
    const container = document.createElement('div')
    document.body.append(container)
    const app = createApp(TeamsView)
    app.mount(container)
    unmount = () => app.unmount()
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalled())
    route.name = 'chat'
    route.params = { teamId: '', conversationId: '' }
    await nextTick()
    finish({
      team: { id: 'team_test', name: 'STALE TEAM', members: [] },
      conversations: [],
    })
    await nextTick()
    await nextTick()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.listRuns).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('STALE TEAM')
  })

  it('hides stale failures, preserves source reports, and exposes lightweight Team controls', async () => {
    mocks.route = reactive({
      name: 'teams',
      params: { teamId: 'team_test', conversationId: 'conv_test' },
    })
    const member = {
      id: 'member_reader',
      display_name: '调研',
      agent_type: 'reader',
      responsibility: '检查事实',
    }
    mocks.get.mockResolvedValue({
      team: {
        id: 'team_test',
        name: '测试 Team',
        description: '验证协作结果',
        members: [member],
      },
      conversations: [
        {
          id: 'conv_test',
          title: '测试对话',
          workspace: { kind: 'none' },
        },
      ],
    })
    mocks.listRuns.mockResolvedValue([
      {
        id: 'run_current',
        state: 'completed',
        user_message: '当前任务',
        members: [member],
        assignments: [
          {
            member_id: member.id,
            status: 'completed',
            result: '成员原始证据',
            error: '',
          },
        ],
        final_response: '当前汇总结论',
        error: '',
      },
      {
        id: 'run_old',
        state: 'failed',
        user_message: '旧任务',
        members: [member],
        assignments: [],
        final_response: '',
        error: '应用在任务执行期间退出',
      },
    ])
    const container = document.createElement('div')
    document.body.append(container)
    const app = createApp(TeamsView)
    app.mount(container)
    unmount = () => app.unmount()
    await vi.waitFor(() =>
      expect(container.textContent).toContain('当前汇总结论'),
    )

    expect(container.textContent).not.toContain('应用在任务执行期间退出')
    expect(container.querySelectorAll('.cairn-select.is-plain')).toHaveLength(2)
    expect(container.textContent).toContain('1/1 份成员报告')
    expect(container.textContent).toContain('查看成员原始报告')

    ;(
      container.querySelector('.team-history-toggle') as HTMLButtonElement
    ).click()
    await nextTick()
    expect(container.textContent).toContain('应用在任务执行期间退出')

    ;(container.querySelector('[title="调研"]') as HTMLButtonElement).click()
    await nextTick()
    const detail = container.querySelector('.team-member-detail')!
    detail.scrollTop = 100
    expect(detail.querySelector('[aria-label="关闭成员详情"]')).not.toBeNull()
  })
})
