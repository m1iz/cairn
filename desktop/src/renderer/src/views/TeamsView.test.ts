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
})
