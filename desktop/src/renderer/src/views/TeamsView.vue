<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Plus, Send, Square, Users, X } from 'lucide-vue-next'
import type {
  CoreGlobalTeamDetail,
  CreateGlobalTeamMemberInput,
  GlobalTeamMemberPayload,
  TeamRunPayload,
} from '@cairn/core'
import type { ProjectInfo } from '../types'
import { core } from '../api/http'
import { useGlobalTeams } from '../composables/useGlobalTeams'
import CairnSelect, {
  type CairnSelectOption,
} from '../components/ui/CairnSelect.vue'
import MarkdownBlock from '../components/chat/MarkdownBlock.vue'

interface MemberDraft extends CreateGlobalTeamMemberInput {
  key: number
}

const route = useRoute()
const router = useRouter()
const store = useGlobalTeams()
const detail = ref<CoreGlobalTeamDetail | null>(null)
const detailLoading = ref(false)
const viewError = ref('')
const createOpen = ref(false)
const createStep = ref<1 | 2>(1)
const creating = ref(false)
const createNameInput = ref<HTMLInputElement | null>(null)
const baseAgents = ref<Array<{ name: string; description: string }>>([])
const projects = ref<ProjectInfo[]>([])
const runs = ref<TeamRunPayload[]>([])
const message = ref('')
const sending = ref(false)
const selectedMember = ref<GlobalTeamMemberPayload | null>(null)
const showHistoricalIssues = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null
let memberKey = 1
let selectionVersion = 0
let disposed = false
const actionPending = ref(false)
const selectedAssignment = computed(() =>
  [...runs.value]
    .reverse()
    .flatMap((run) => run.assignments)
    .find((item) => item.member_id === selectedMember.value?.id),
)

const form = reactive({
  name: '',
  description: '',
  workspace: 'none',
  members: [newMember()] as MemberDraft[],
})

const teamId = computed(() => String(route.params.teamId ?? ''))
const conversationId = computed(() => String(route.params.conversationId ?? ''))
const activeConversation = computed(() => {
  const conversations = detail.value?.conversations ?? []
  return (
    conversations.find((item) => item.id === conversationId.value) ??
    conversations[0] ??
    null
  )
})
const roleOptions = computed<CairnSelectOption[]>(() =>
  baseAgents.value.map((agent) => ({
    value: agent.name,
    label: agent.name,
    description: agent.description,
  })),
)
const teamOptions = computed<CairnSelectOption[]>(() =>
  store.teams.value.map((team) => ({
    value: team.id,
    label: team.name,
    description: `${team.conversation_count} 个对话 · ${team.members.length} 名成员`,
  })),
)
const conversationOptions = computed<CairnSelectOption[]>(() =>
  (detail.value?.conversations ?? []).map((conversation) => ({
    value: conversation.id,
    label: conversation.title,
  })),
)
const workspaceOptions = computed<CairnSelectOption[]>(() => [
  {
    value: 'none',
    label: '不绑定工作区',
    description: '适合研究、规划和通用任务',
  },
  ...projects.value.map((project) => ({
    value: project.project_id,
    label: project.project_name || project.project_path,
    description: project.project_path,
  })),
])
const activeRun = computed(
  () =>
    [...runs.value]
      .reverse()
      .find(
        (run) =>
          !['completed', 'partial', 'cancelled', 'failed'].includes(run.state),
      ) ?? null,
)
const latestRun = computed(() => runs.value.at(-1) ?? null)
const historicalIssueRuns = computed(() =>
  runs.value.filter(
    (run) =>
      run.error.includes('应用在任务执行期间退出') ||
      (run.id !== latestRun.value?.id &&
        (run.state === 'failed' || run.state === 'cancelled')),
  ),
)
const visibleRuns = computed(() =>
  showHistoricalIssues.value
    ? runs.value
    : runs.value.filter(
        (run) => !historicalIssueRuns.value.some((item) => item.id === run.id),
      ),
)

function runLabel(state: TeamRunPayload['state']): string {
  return {
    queued: '正在排队',
    planning: '正在规划',
    running: '队友协作中',
    awaiting_user: '等待你的确认',
    synthesizing: '正在汇总',
    completed: '已完成',
    partial: '部分完成',
    cancelled: '已取消',
    failed: '执行失败',
  }[state]
}

async function refreshRuns() {
  if (
    disposed ||
    route.name !== 'teams' ||
    !teamId.value ||
    !activeConversation.value
  )
    return
  const version = selectionVersion
  const selectedTeam = teamId.value
  const selectedConversation = activeConversation.value.id
  try {
    const loaded = await store.listRuns(selectedTeam, selectedConversation)
    if (!disposed && version === selectionVersion && route.name === 'teams')
      runs.value = loaded
  } catch (reason) {
    if (disposed || version !== selectionVersion || route.name !== 'teams')
      return
    viewError.value = reason instanceof Error ? reason.message : String(reason)
  }
}

async function sendTask() {
  const content = message.value.trim()
  if (!content || sending.value || activeRun.value || !activeConversation.value)
    return
  const version = selectionVersion
  sending.value = true
  viewError.value = ''
  try {
    const run = await store.submit(
      teamId.value,
      activeConversation.value.id,
      content,
    )
    if (disposed || version !== selectionVersion || route.name !== 'teams')
      return
    if (!runs.value.some((item) => item.id === run.id)) runs.value.push(run)
    message.value = ''
    await nextTick()
  } catch (reason) {
    viewError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    sending.value = false
  }
}

async function cancelActiveRun() {
  if (!activeRun.value || !activeConversation.value || actionPending.value)
    return
  actionPending.value = true
  try {
    await store.cancel(
      teamId.value,
      activeConversation.value.id,
      activeRun.value.id,
    )
    await refreshRuns()
  } catch (reason) {
    viewError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    actionPending.value = false
  }
}

async function resumeRun(run: TeamRunPayload) {
  if (!activeConversation.value || actionPending.value) return
  actionPending.value = true
  try {
    await store.resume(teamId.value, activeConversation.value.id, run.id)
    await refreshRuns()
  } catch (reason) {
    viewError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    actionPending.value = false
  }
}

async function retryRun(run: TeamRunPayload) {
  if (actionPending.value || activeRun.value) return
  actionPending.value = true
  try {
    await store.retry(run.team_id, run.conversation_id, run.id)
    await refreshRuns()
  } catch (reason) {
    viewError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    actionPending.value = false
  }
}

async function selectTeam(value: string) {
  const team = store.teams.value.find((item) => item.id === value)
  await router.push({
    name: 'teams',
    params: {
      teamId: value,
      ...(team?.latest_conversation
        ? { conversationId: team.latest_conversation.id }
        : {}),
    },
  })
}

async function createConversation() {
  if (!detail.value) return
  const conversation = await store.createConversation(detail.value.team.id, {
    title: `团队对话 ${detail.value.conversations.length + 1}`,
  })
  await router.push({
    name: 'teams',
    params: { teamId: detail.value.team.id, conversationId: conversation.id },
  })
}

async function selectConversation(value: string) {
  await router.push({
    name: 'teams',
    params: { teamId: teamId.value, conversationId: value },
  })
}

function newMember(): MemberDraft {
  return {
    key: memberKey++,
    display_name: '',
    agent_type: '',
    responsibility: '',
  }
}

function resetCreate() {
  form.name = ''
  form.description = ''
  form.workspace = 'none'
  form.members.splice(0, form.members.length, newMember())
  createStep.value = 1
}

function openCreate() {
  resetCreate()
  createOpen.value = true
  void nextTick(() => createNameInput.value?.focus())
}

function closeCreate() {
  if (creating.value) return
  createOpen.value = false
}

function addMember() {
  if (form.members.length < 6) form.members.push(newMember())
}

function removeMember(index: number) {
  if (form.members.length > 1) form.members.splice(index, 1)
}

function validateStepOne(): boolean {
  if (form.name.trim()) return true
  viewError.value = '请填写 Team 名称。'
  void nextTick(() => createNameInput.value?.focus())
  return false
}

function validateMembers(): boolean {
  const names = new Set<string>()
  for (const member of form.members) {
    const name = member.display_name.trim()
    if (!name || !member.agent_type) {
      viewError.value = '每名成员都需要名称和基础角色。'
      return false
    }
    const folded = name.toLocaleLowerCase()
    if (names.has(folded)) {
      viewError.value = '成员名称不能重复。'
      return false
    }
    names.add(folded)
  }
  return true
}

async function submitCreate() {
  if (!validateMembers() || creating.value) return
  creating.value = true
  viewError.value = ''
  try {
    const created = await store.create({
      name: form.name.trim(),
      description: form.description.trim(),
      default_workspace:
        form.workspace === 'none'
          ? { kind: 'none' }
          : {
              kind: 'project',
              project_id: form.workspace,
              path:
                projects.value.find(
                  (project) => project.project_id === form.workspace,
                )?.project_path || undefined,
            },
      members: form.members.map((member) => ({
        display_name: member.display_name.trim(),
        agent_type: member.agent_type,
        responsibility: String(member.responsibility ?? '').trim(),
      })),
    })
    createOpen.value = false
    const conversation = created.conversations[0]
    await router.push({
      name: 'teams',
      params: {
        teamId: created.team.id,
        ...(conversation ? { conversationId: conversation.id } : {}),
      },
    })
  } catch (reason) {
    viewError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    creating.value = false
  }
}

async function loadSelection() {
  const version = ++selectionVersion
  if (disposed || route.name !== 'teams') return
  if (!teamId.value) {
    detail.value = null
    const first = store.teams.value[0]
    if (first) {
      await router.replace({
        name: 'teams',
        params: {
          teamId: first.id,
          ...(first.latest_conversation
            ? { conversationId: first.latest_conversation.id }
            : {}),
        },
      })
    }
    return
  }
  detailLoading.value = true
  viewError.value = ''
  try {
    const loaded = await store.get(teamId.value)
    if (disposed || version !== selectionVersion || route.name !== 'teams')
      return
    detail.value = loaded
    runs.value = []
    showHistoricalIssues.value = false
    selectedMember.value = null
    await refreshRuns()
  } catch (reason) {
    if (disposed || version !== selectionVersion || route.name !== 'teams')
      return
    detail.value = null
    viewError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    if (version === selectionVersion) detailLoading.value = false
  }
}

async function loadInitial() {
  try {
    const [, definitions, projectItems] = await Promise.all([
      store.load(),
      core('agentDefinitions.get'),
      core('projects.list'),
    ])
    baseAgents.value = definitions.availableBaseAgents
    projects.value = projectItems
    await loadSelection()
  } catch (reason) {
    viewError.value = reason instanceof Error ? reason.message : String(reason)
  }
}

function handleCreateRequest() {
  openCreate()
}

watch(
  () => [route.name, route.params.teamId, route.params.conversationId],
  loadSelection,
)
onMounted(() => {
  window.addEventListener('cairn:create-team', handleCreateRequest)
  void loadInitial()
  pollTimer = setInterval(() => {
    if (activeRun.value) void refreshRuns()
  }, 1_500)
})
onBeforeUnmount(() => {
  disposed = true
  selectionVersion++
  window.removeEventListener('cairn:create-team', handleCreateRequest)
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <section class="main-view teams-view">
    <div v-if="detailLoading" class="teams-centered">正在切换团队…</div>

    <div v-else-if="!detail" class="teams-empty-state">
      <div class="teams-empty-mark"><Users :size="23" /></div>
      <h1>创建你的第一个 Team</h1>
      <p>配置长期协作的成员，然后只需要把任务交给整个团队。</p>
      <button class="tool-button primary-action" @click="openCreate">
        <Plus :size="15" />创建 Team
      </button>
    </div>

    <template v-else>
      <header class="teams-chat-head">
        <div>
          <CairnSelect
            :model-value="detail.team.id"
            :options="teamOptions"
            variant="plain"
            aria-label="切换 Team"
            @update:model-value="selectTeam"
          />
          <div class="team-conversation-line">
            <CairnSelect
              v-if="activeConversation"
              :model-value="activeConversation.id"
              :options="conversationOptions"
              variant="plain"
              aria-label="切换团队对话"
              @update:model-value="selectConversation"
            />
            <span>· {{ detail.team.members.length }} 名成员</span>
            <span>{{
              activeConversation?.workspace.kind === 'none'
                ? '无工作区'
                : activeConversation?.workspace.kind === 'folder'
                  ? activeConversation.workspace.path
                  : activeConversation?.workspace.kind === 'project'
                    ? activeConversation.workspace.path || '项目工作区'
                    : ''
            }}</span>
          </div>
        </div>
        <div class="teams-head-actions">
          <button
            class="tool-button team-head-action"
            @click="createConversation"
          >
            <Plus :size="14" />新对话
          </button>
          <button class="tool-button team-head-action" @click="openCreate">
            <Users :size="14" />新 Team
          </button>
          <div class="teams-head-members" aria-label="Team 成员">
            <button
              v-for="member in detail.team.members"
              :key="member.id"
              :title="member.display_name"
              @click="selectedMember = member"
            >
              {{ member.display_name.slice(0, 1) }}
            </button>
          </div>
        </div>
      </header>

      <main class="teams-chat-body">
        <div v-if="!runs.length" class="teams-ready">
          <h2>团队已经准备好</h2>
          <p>
            {{
              detail.team.description ||
              'Cairn 将根据成员职责自动分配任务并汇总结果。'
            }}
          </p>
          <div class="teams-ready-members">
            <button
              v-for="member in detail.team.members"
              :key="member.id"
              @click="selectedMember = member"
            >
              <span>{{ member.display_name.slice(0, 1) }}</span>
              <div>
                <strong>{{ member.display_name }}</strong>
                <small>{{ member.agent_type }}</small>
              </div>
            </button>
          </div>
        </div>
        <div v-else class="team-transcript" aria-live="polite">
          <button
            v-if="historicalIssueRuns.length"
            class="team-history-toggle"
            :aria-expanded="showHistoricalIssues"
            @click="showHistoricalIssues = !showHistoricalIssues"
          >
            {{
              showHistoricalIssues
                ? '隐藏历史异常记录'
                : `显示 ${historicalIssueRuns.length} 条历史异常记录`
            }}
          </button>
          <article v-for="run in visibleRuns" :key="run.id" class="team-run">
            <div class="team-user-message">{{ run.user_message }}</div>
            <section class="team-coordinator-card" :class="`is-${run.state}`">
              <header>
                <strong>Cairn · 团队协调</strong
                ><span>{{ runLabel(run.state) }}</span>
              </header>
              <div v-if="run.assignments.length" class="team-assignment-list">
                <div
                  v-for="assignment in run.assignments"
                  :key="assignment.member_id"
                >
                  <i :class="`is-${assignment.status}`" />
                  <span>{{
                    run.members.find((item) => item.id === assignment.member_id)
                      ?.display_name
                  }}</span>
                  <small>{{
                    assignment.status === 'completed'
                      ? '已完成'
                      : assignment.status === 'failed'
                        ? '失败'
                        : assignment.status === 'running'
                          ? '执行中'
                          : assignment.status === 'cancelled'
                            ? '已取消'
                            : '等待中'
                  }}</small>
                  <details v-if="assignment.result || assignment.error">
                    <summary>
                      查看结果{{ assignment.error ? '与错误' : '' }}
                    </summary>
                    <p v-if="assignment.error" class="team-run-error">
                      {{ assignment.error }}
                    </p>
                    <MarkdownBlock
                      v-if="assignment.result"
                      :content="assignment.result"
                    />
                  </details>
                </div>
              </div>
              <p v-if="run.error" class="team-run-error">{{ run.error }}</p>
              <button
                v-if="
                  run.id === latestRun?.id &&
                  ['partial', 'failed'].includes(run.state)
                "
                class="tool-button"
                :disabled="actionPending || Boolean(activeRun)"
                @click="retryRun(run)"
              >
                重试未完成成员并重新复核
              </button>
              <small v-if="run.model_label"
                >本次模型：{{
                  run.model_label.split(' · ').slice(0, 2).join(' · ')
                }}</small
              >
              <p v-if="run.state === 'awaiting_user'">
                部分成员已暂停，请展开成员结果查看原因。继续会保留已完成结果，并向尚未开始的成员投递任务。
              </p>
              <button
                v-if="run.state === 'awaiting_user'"
                class="tool-button"
                :disabled="actionPending"
                @click="resumeRun(run)"
              >
                确认后继续
              </button>
            </section>
            <section v-if="run.final_response" class="team-final-response">
              <header>
                <span>Cairn · 自动汇总</span>
                <small
                  >{{
                    run.assignments.filter(
                      (item) => item.status === 'completed',
                    ).length
                  }}/{{ run.assignments.length }} 份成员报告</small
                >
              </header>
              <MarkdownBlock :content="run.final_response" />
              <details
                v-if="run.assignments.some((item) => item.result || item.error)"
                class="team-source-reports"
              >
                <summary>查看成员原始报告</summary>
                <section
                  v-for="assignment in run.assignments"
                  :key="assignment.member_id"
                >
                  <strong>{{
                    run.members.find((item) => item.id === assignment.member_id)
                      ?.display_name || assignment.member_id
                  }}</strong>
                  <p v-if="assignment.error" class="team-run-error">
                    {{ assignment.error }}
                  </p>
                  <MarkdownBlock
                    v-if="assignment.result"
                    :content="assignment.result"
                  />
                  <p v-else-if="!assignment.error">未返回内容</p>
                </section>
              </details>
            </section>
          </article>
        </div>
      </main>

      <form class="teams-composer-placeholder" @submit.prevent="sendTask">
        <textarea
          v-model="message"
          rows="3"
          :disabled="sending || Boolean(activeRun)"
          placeholder="给团队一个任务。Cairn 会自动分配给成员并汇总结果"
          @keydown.ctrl.enter.prevent="sendTask"
        />
        <div>
          <button type="button" disabled><Plus :size="17" /></button>
          <span>{{
            activeRun ? runLabel(activeRun.state) : 'Ctrl + Enter 发送'
          }}</span>
          <button
            v-if="activeRun"
            type="button"
            aria-label="停止任务"
            @click="cancelActiveRun"
          >
            <Square :size="15" />
          </button>
          <button
            v-else
            type="submit"
            aria-label="发送任务"
            :disabled="!message.trim() || sending || Boolean(activeRun)"
          >
            <Send :size="17" />
          </button>
        </div>
      </form>

      <aside v-if="selectedMember" class="team-member-detail">
        <header class="member-detail-toolbar">
          <span>成员详情</span>
          <button aria-label="关闭成员详情" @click="selectedMember = null">
            <X :size="16" />
          </button>
        </header>
        <div class="member-detail-content">
          <div class="member-detail-avatar">
            {{ selectedMember.display_name.slice(0, 1) }}
          </div>
          <h2>{{ selectedMember.display_name }}</h2>
          <small>{{ selectedMember.agent_type }}</small>
          <section v-if="selectedAssignment">
            <p>
              最近任务：{{
                (
                  {
                    pending: '等待中',
                    running: '执行中',
                    completed: '已完成',
                    failed: '失败',
                    cancelled: '已取消',
                  } as const
                )[selectedAssignment.status]
              }}
            </p>
            <p v-if="selectedAssignment.error" class="team-run-error">
              {{ selectedAssignment.error }}
            </p>
            <MarkdownBlock
              v-if="selectedAssignment.result"
              :content="selectedAssignment.result"
            />
          </section>
          <p>
            {{
              selectedMember.responsibility ||
              '使用基础角色职责，由协调器按任务分配工作。'
            }}
          </p>
          <dl>
            <dt>作用范围</dt>
            <dd>仅当前 Team</dd>
            <dt>任务分配</dt>
            <dd>由团队协调器自动完成</dd>
          </dl>
        </div>
      </aside>
    </template>

    <div v-if="viewError" class="team-view-error" role="alert">
      {{ viewError }}
      <button aria-label="关闭提示" @click="viewError = ''">×</button>
    </div>

    <div
      v-if="createOpen"
      class="team-create-backdrop"
      @click.self="closeCreate"
    >
      <form
        class="global-team-create"
        @submit.prevent="
          createStep === 1
            ? validateStepOne() && (createStep = 2)
            : submitCreate()
        "
      >
        <header>
          <div>
            <h2>创建 Team</h2>
            <p>
              {{
                createStep === 1 ? '设置团队名称和用途' : '配置团队成员与职责'
              }}
            </p>
          </div>
          <button
            type="button"
            class="team-dialog-close"
            aria-label="关闭"
            @click="closeCreate"
          >
            <X :size="17" />
          </button>
        </header>

        <div class="team-create-progress">
          <span :class="{ active: createStep === 1 }">1 基本信息</span>
          <i />
          <span :class="{ active: createStep === 2 }">2 团队成员</span>
        </div>

        <div v-if="createStep === 1" class="team-create-page">
          <label>
            <span>Team 名称</span>
            <input
              ref="createNameInput"
              v-model="form.name"
              maxlength="120"
              placeholder="例如：前端质量团队"
            />
          </label>
          <label>
            <span>这个 Team 主要负责什么？ <em>可选</em></span>
            <textarea
              v-model="form.description"
              rows="4"
              maxlength="1000"
              placeholder="例如：负责界面实现、交互检查和回归测试。"
            />
            <small>后续仍可修改，不需要编写系统提示词。</small>
          </label>
          <label>
            <span>默认工作区</span>
            <CairnSelect
              v-model="form.workspace"
              :options="workspaceOptions"
              aria-label="Team 默认工作区"
            />
            <small
              >Team
              本身保持独立；这里只决定成员执行任务时可以访问的目录。</small
            >
          </label>
        </div>

        <div v-else class="team-create-page member-page">
          <article
            v-for="(member, index) in form.members"
            :key="member.key"
            class="team-member-editor"
          >
            <div class="member-editor-head">
              <strong>成员 {{ index + 1 }}</strong>
              <button
                v-if="form.members.length > 1"
                type="button"
                @click="removeMember(index)"
              >
                移除
              </button>
            </div>
            <label>
              <span>显示名称</span>
              <input
                v-model="member.display_name"
                maxlength="80"
                placeholder="例如：界面实现"
              />
            </label>
            <label>
              <span>基础角色</span>
              <CairnSelect
                v-model="member.agent_type"
                :options="roleOptions"
                placeholder="选择基础角色"
                aria-label="基础角色"
              />
            </label>
            <label>
              <span>希望这个成员负责什么？ <em>可选</em></span>
              <textarea
                v-model="member.responsibility"
                rows="3"
                maxlength="4000"
                placeholder="例如：负责实现确认后的界面改动，并运行相关测试。"
              />
            </label>
          </article>
          <button
            v-if="form.members.length < 6"
            type="button"
            class="team-add-member"
            @click="addMember"
          >
            <Plus :size="15" />添加成员
          </button>
        </div>

        <footer>
          <button
            v-if="createStep === 2"
            type="button"
            class="tool-button"
            @click="createStep = 1"
          >
            <ArrowLeft :size="14" />返回
          </button>
          <span v-else />
          <button class="tool-button primary-action" :disabled="creating">
            {{
              createStep === 1 ? '下一步' : creating ? '正在创建…' : '创建 Team'
            }}
          </button>
        </footer>
      </form>
    </div>
  </section>
</template>

<style scoped>
.teams-view {
  position: relative;
  min-height: 0;
  background: rgb(var(--bg));
}
.teams-centered,
.teams-empty-state {
  height: 100%;
  display: grid;
  place-content: center;
  justify-items: center;
  text-align: center;
  color: rgb(var(--fg-muted));
}
.teams-empty-state {
  gap: 12px;
}
.teams-empty-state h1,
.teams-empty-state p {
  margin: 0;
}
.teams-empty-state h1 {
  color: rgb(var(--fg));
  font-size: 22px;
}
.teams-empty-state p {
  max-width: 440px;
  font-size: var(--font-size-lg);
}
.teams-empty-mark {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-lg);
  color: rgb(var(--fg));
}
.teams-chat-head {
  min-height: 64px;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgb(var(--border));
}
.teams-chat-head h1,
.teams-chat-head p {
  margin: 0;
}
.team-conversation-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}
.teams-chat-head h1 {
  font-size: var(--font-size-lg);
}
.teams-chat-head p {
  margin-top: 3px;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}
.teams-head-members {
  display: flex;
  padding-right: 6px;
}
.teams-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.teams-head-actions .team-head-action {
  border-color: transparent;
  background: transparent;
}
.teams-head-actions .team-head-action:hover {
  border-color: transparent;
  background: rgb(var(--bg-inset));
}
.teams-head-members button {
  width: 28px;
  height: 28px;
  margin-right: -6px;
  display: grid;
  place-items: center;
  border: 2px solid rgb(var(--bg));
  border-radius: 50%;
  background: rgb(var(--bg-inset));
  font-size: var(--font-size-xs);
  font-weight: 700;
}
.teams-chat-body {
  min-height: 0;
  flex: 1;
  overflow: auto;
  display: grid;
  place-items: center;
  padding: 40px 24px 190px;
}
.teams-ready {
  width: min(620px, 100%);
  text-align: center;
}
.teams-ready h2,
.teams-ready p {
  margin: 0;
}
.teams-ready h2 {
  font-size: 22px;
}
.teams-ready p {
  margin-top: 10px;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-lg);
}
.teams-ready-members {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 24px;
}
.teams-ready-members button {
  min-width: 150px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  text-align: left;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-lg);
}
.teams-ready-members button > span {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: var(--radius);
  background: rgb(var(--bg-inset));
  font-weight: 700;
}
.teams-ready-members strong,
.teams-ready-members small {
  display: block;
}
.teams-ready-members small {
  margin-top: 2px;
  color: rgb(var(--fg-muted));
}
.teams-composer-placeholder {
  position: absolute;
  left: 50%;
  bottom: 20px;
  width: min(760px, calc(100% - 48px));
  transform: translateX(-50%);
  padding: 18px;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-lg);
  background: rgb(var(--bg-elevated));
  box-shadow: var(--shadow-md);
  color: rgb(var(--fg-muted));
}
.teams-composer-placeholder p {
  min-height: 48px;
  margin: 0;
  font-size: var(--font-size-lg);
}
.teams-composer-placeholder textarea {
  width: 100%;
  min-height: 54px;
  padding: 0;
  border: 0;
  outline: 0;
  resize: none;
  background: transparent;
  color: rgb(var(--fg));
  font: inherit;
}
.teams-composer-placeholder div {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.teams-composer-placeholder button {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid rgb(var(--border));
  border-radius: 50%;
  opacity: 0.55;
}
.teams-composer-placeholder span {
  font-size: var(--font-size-sm);
}
.team-create-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 24%);
}
.global-team-create {
  width: min(720px, 100%);
  max-height: min(780px, calc(100vh - 48px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-lg);
  background: rgb(var(--bg));
  box-shadow: var(--shadow-lg);
}
.global-team-create > header,
.global-team-create > footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px;
}
.global-team-create > header {
  border-bottom: 1px solid rgb(var(--border));
}
.global-team-create > footer {
  border-top: 1px solid rgb(var(--border));
}
.global-team-create h2,
.global-team-create header p {
  margin: 0;
}
.global-team-create h2 {
  font-size: 18px;
}
.global-team-create header p {
  margin-top: 4px;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}
.team-dialog-close {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--radius);
}
.team-create-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px 0;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}
.team-create-progress span.active {
  color: rgb(var(--fg));
  font-weight: 650;
}
.team-create-progress i {
  width: 30px;
  height: 1px;
  background: rgb(var(--border));
}
.team-create-page {
  min-height: 320px;
  overflow: auto;
  padding: 20px;
}
.team-create-page label {
  display: grid;
  gap: 7px;
  margin-bottom: 18px;
  font-size: var(--font-size-md);
  font-weight: 600;
}
.team-create-page label em {
  color: rgb(var(--fg-muted));
  font-style: normal;
  font-weight: 400;
}
.team-create-page input,
.team-create-page textarea {
  width: 100%;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius);
  padding: 10px 12px;
  background: rgb(var(--bg));
  color: rgb(var(--fg));
  resize: vertical;
}
.team-create-page small {
  color: rgb(var(--fg-muted));
  font-weight: 400;
}
.member-page {
  display: grid;
  gap: 12px;
}
.team-member-editor {
  padding: 14px;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-lg);
}
.team-member-editor label:last-child {
  margin-bottom: 0;
}
.member-editor-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
}
.member-editor-head button {
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}
.team-add-member {
  justify-self: start;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border-radius: var(--radius);
  color: rgb(var(--fg-muted));
}
.team-view-error {
  position: absolute;
  z-index: 90;
  left: 50%;
  top: 78px;
  transform: translateX(-50%);
  display: flex;
  gap: 12px;
  padding: 9px 12px;
  border: 1px solid rgb(var(--danger) / 0.35);
  border-radius: var(--radius);
  background: rgb(var(--danger) / 0.08);
  color: rgb(var(--danger));
  font-size: var(--font-size-md);
}
.team-transcript {
  width: min(760px, 100%);
  align-self: start;
  display: grid;
  gap: 38px;
}
.team-history-toggle {
  justify-self: center;
  margin-bottom: -18px;
  border-radius: 999px;
  padding: 5px 10px;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}
.team-history-toggle:hover {
  background: rgb(var(--bg-inset));
  color: rgb(var(--fg));
}
.team-run {
  display: grid;
  gap: 14px;
}
.team-user-message {
  justify-self: end;
  max-width: 76%;
  padding: 11px 14px;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-lg);
  white-space: pre-wrap;
}
.team-coordinator-card,
.team-final-response {
  padding: 14px 16px;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-lg);
  background: rgb(var(--bg-elevated));
}
.team-coordinator-card > header {
  display: flex;
  justify-content: space-between;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}
.team-coordinator-card > header strong {
  color: rgb(var(--fg));
}
.team-assignment-list {
  display: grid;
  gap: 8px;
  margin-top: 13px;
}
.team-assignment-list > div {
  display: grid;
  grid-template-columns: 8px 1fr auto;
  align-items: center;
  gap: 9px;
}
.team-assignment-list i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgb(var(--fg-muted));
}
.team-assignment-list details {
  grid-column: 2 / -1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.team-assignment-list summary {
  cursor: pointer;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}
.team-assignment-list i.is-completed {
  background: rgb(var(--success));
}
.team-assignment-list i.is-failed {
  background: rgb(var(--danger));
}
.team-assignment-list small {
  color: rgb(var(--fg-muted));
}
.team-run-error {
  color: rgb(var(--danger));
}
.team-final-response header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}
.team-final-response header small {
  color: rgb(var(--fg-subtle));
}
.team-final-response :deep(.markdown-body) {
  margin: 12px 0 0;
  line-height: 1.65;
}
.team-source-reports {
  margin-top: 14px;
  border-top: 1px solid rgb(var(--border));
  padding-top: 12px;
}
.team-source-reports > summary {
  cursor: pointer;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}
.team-source-reports > section {
  margin-top: 14px;
  border-left: 2px solid rgb(var(--border));
  padding-left: 12px;
}
.team-source-reports > section > strong {
  font-size: var(--font-size-sm);
}
.team-source-reports > section > p {
  margin: 8px 0 0;
}
.team-source-reports :deep(.markdown-body) {
  margin-top: 8px;
}
.team-member-detail {
  max-height: calc(100% - 100px);
  overflow-y: auto;
  position: absolute;
  z-index: 30;
  top: 76px;
  right: 18px;
  width: min(300px, calc(100% - 36px));
  padding: 0;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-lg);
  background: rgb(var(--bg-elevated));
  box-shadow: var(--shadow-lg);
}
.member-detail-toolbar {
  position: sticky;
  z-index: 2;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 48px;
  border-bottom: 1px solid rgb(var(--border));
  padding: 8px 10px 8px 20px;
  background: rgb(var(--bg-elevated));
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}
.member-detail-toolbar > button {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--radius);
}
.member-detail-toolbar > button:hover {
  background: rgb(var(--bg-inset));
  color: rgb(var(--fg));
}
.member-detail-content {
  padding: 20px;
}
.member-detail-avatar {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: var(--radius);
  background: rgb(var(--bg-inset));
  font-weight: 700;
}
.team-member-detail h2 {
  margin: 12px 0 2px;
  font-size: 18px;
}
.team-member-detail small {
  color: rgb(var(--fg-muted));
}
.team-member-detail p {
  margin: 18px 0;
  line-height: 1.55;
}
.team-member-detail dl {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 12px;
  font-size: var(--font-size-sm);
}
.team-member-detail dt {
  color: rgb(var(--fg-muted));
}
.team-member-detail dd {
  margin: 0;
}
</style>
