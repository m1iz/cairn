import { computed, ref, type Ref } from 'vue'
import type {
  CoreGlobalTeamDetail,
  CoreGlobalTeamListItem,
  CoreOperationArgs,
  CoreOperationKey,
  CoreOperationResult,
  CreateGlobalTeamInput,
  TeamConversationPayload,
  TeamWorkspaceBinding,
  TeamRunPayload,
} from '@cairn/core'
import { core } from '../api/http'

type TeamOperation = Extract<CoreOperationKey, `teams.${string}`>
type TeamInvoker = <Key extends TeamOperation>(
  key: Key,
  ...args: CoreOperationArgs<Key>
) => Promise<CoreOperationResult<Key>>

export interface GlobalTeamsStore {
  retry: (
    teamId: string,
    conversationId: string,
    runId: string,
  ) => Promise<TeamRunPayload>
  teams: Ref<CoreGlobalTeamListItem[]>
  loading: Ref<boolean>
  error: Ref<string>
  loaded: Readonly<Ref<boolean>>
  load: (force?: boolean) => Promise<CoreGlobalTeamListItem[]>
  get: (teamId: string) => Promise<CoreGlobalTeamDetail>
  create: (input: CreateGlobalTeamInput) => Promise<CoreGlobalTeamDetail>
  createConversation: (
    teamId: string,
    input: { title: string; workspace?: TeamWorkspaceBinding | null },
  ) => Promise<TeamConversationPayload>
  listRuns: (
    teamId: string,
    conversationId: string,
  ) => Promise<TeamRunPayload[]>
  submit: (
    teamId: string,
    conversationId: string,
    message: string,
  ) => Promise<TeamRunPayload>
  cancel: (
    teamId: string,
    conversationId: string,
    runId: string,
  ) => Promise<TeamRunPayload>
  resume: (
    teamId: string,
    conversationId: string,
    runId: string,
  ) => Promise<TeamRunPayload>
}

export function createGlobalTeamsStore(invoke: TeamInvoker): GlobalTeamsStore {
  const teams = ref<CoreGlobalTeamListItem[]>([])
  const loading = ref(false)
  const error = ref('')
  const hasLoaded = ref(false)
  let loadPromise: Promise<CoreGlobalTeamListItem[]> | null = null

  async function load(force = false): Promise<CoreGlobalTeamListItem[]> {
    if (loadPromise && !force) return loadPromise
    loading.value = true
    error.value = ''
    loadPromise = invoke('teams.list')
      .then((payload) => {
        teams.value = payload
        hasLoaded.value = true
        return payload
      })
      .catch((reason) => {
        error.value = readableError(reason)
        throw reason
      })
      .finally(() => {
        loading.value = false
        loadPromise = null
      })
    return loadPromise
  }

  async function get(teamId: string): Promise<CoreGlobalTeamDetail> {
    error.value = ''
    try {
      return await invoke('teams.get', teamId)
    } catch (reason) {
      error.value = readableError(reason)
      throw reason
    }
  }

  async function create(
    input: CreateGlobalTeamInput,
  ): Promise<CoreGlobalTeamDetail> {
    error.value = ''
    try {
      const created = await invoke('teams.create', input)
      await load(true)
      return created
    } catch (reason) {
      error.value = readableError(reason)
      throw reason
    }
  }

  async function createConversation(
    teamId: string,
    input: { title: string; workspace?: TeamWorkspaceBinding | null },
  ): Promise<TeamConversationPayload> {
    error.value = ''
    try {
      const conversation = await invoke(
        'teams.createConversation',
        teamId,
        input,
      )
      await load(true)
      return conversation
    } catch (reason) {
      error.value = readableError(reason)
      throw reason
    }
  }

  const listRuns = (teamId: string, conversationId: string) =>
    invoke('teams.listRuns', teamId, conversationId)
  const submit = (teamId: string, conversationId: string, message: string) =>
    invoke('teams.submit', teamId, conversationId, message)
  const cancel = (teamId: string, conversationId: string, runId: string) =>
    invoke('teams.cancel', teamId, conversationId, runId)
  const resume = (teamId: string, conversationId: string, runId: string) =>
    invoke('teams.resume', teamId, conversationId, runId)

  return {
    teams,
    loading,
    error,
    loaded: computed(() => hasLoaded.value),
    load,
    get,
    create,
    createConversation,
    listRuns,
    submit,
    cancel,
    resume,
    retry: (teamId, conversationId, runId) =>
      invoke('teams.retry', teamId, conversationId, runId),
  }
}

function readableError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

const sharedStore = createGlobalTeamsStore(core as TeamInvoker)

export function useGlobalTeams(): GlobalTeamsStore {
  return sharedStore
}
