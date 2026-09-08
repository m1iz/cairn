import { randomUUID } from 'node:crypto'
import { nowTs } from '../util/time'

export const GLOBAL_TEAM_SCHEMA_VERSION = 1
export const GLOBAL_TEAM_MEMBER_LIMIT = 6

const TEAM_ID_RE = /^team_[a-f0-9]{24}$/
const CONVERSATION_ID_RE = /^teamconv_[a-f0-9]{24}$/
const MEMBER_ID_RE = /^teammember_[a-f0-9]{24}$/
const RUN_ID_RE = /^teamrun_[a-f0-9]{24}$/

export type TeamWorkspaceBinding =
  | { kind: 'none' }
  | { kind: 'folder'; path: string }
  | { kind: 'project'; project_id: string; path?: string }

export interface GlobalTeamMemberPayload {
  id: string
  display_name: string
  agent_type: string
  responsibility: string
  enabled: boolean
  created_at: number
  updated_at: number
}

export interface GlobalTeamPayload {
  version: number
  id: string
  name: string
  description: string
  default_workspace: TeamWorkspaceBinding
  members: GlobalTeamMemberPayload[]
  created_at: number
  updated_at: number
  archived_at: number | null
  revision: number
}

export interface TeamConversationPayload {
  version: number
  id: string
  team_id: string
  title: string
  workspace: TeamWorkspaceBinding
  created_at: number
  updated_at: number
  archived_at: number | null
  revision: number
}

export type TeamRunState =
  | 'queued'
  | 'planning'
  | 'running'
  | 'awaiting_user'
  | 'synthesizing'
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'failed'

export interface TeamRunMemberSnapshot {
  id: string
  display_name: string
  agent_type: string
  responsibility: string
}

export interface TeamRunAssignment {
  dispatched?: boolean
  started_at?: number | null
  finished_at?: number | null
  member_id: string
  task: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  result: string
  error: string
}

export interface TeamRunPayload {
  retry_of_run_id?: string
  model_label?: string
  version: number
  id: string
  team_id: string
  conversation_id: string
  user_message: string
  state: TeamRunState
  workspace: TeamWorkspaceBinding
  members: TeamRunMemberSnapshot[]
  assignments: TeamRunAssignment[]
  final_response: string
  error: string
  created_at: number
  updated_at: number
  started_at: number | null
  finished_at: number | null
  revision: number
}

export interface CreateGlobalTeamMemberInput {
  display_name: string
  agent_type: string
  responsibility?: string | null
}

export interface CreateGlobalTeamInput {
  name: string
  description?: string | null
  default_workspace?: TeamWorkspaceBinding | null
  members: CreateGlobalTeamMemberInput[]
  first_conversation_title?: string | null
}

export function createGlobalTeamRecord(
  input: CreateGlobalTeamInput,
  timestamp = nowTs(),
): { team: GlobalTeamPayload; conversation: TeamConversationPayload } {
  const members = normalizeMembers(input.members, timestamp)
  const teamId = newDomainId('team')
  const workspace = normalizeWorkspace(input.default_workspace)
  const team: GlobalTeamPayload = {
    version: GLOBAL_TEAM_SCHEMA_VERSION,
    id: teamId,
    name: requiredText(input.name, 'team name', 120),
    description: optionalText(input.description, 1000),
    default_workspace: workspace,
    members,
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
    revision: 1,
  }
  return {
    team,
    conversation: createTeamConversationRecord(
      team,
      input.first_conversation_title ?? '新团队对话',
      workspace,
      timestamp,
    ),
  }
}

export function createTeamConversationRecord(
  team: GlobalTeamPayload,
  title: string,
  workspace: TeamWorkspaceBinding = team.default_workspace,
  timestamp = nowTs(),
): TeamConversationPayload {
  return {
    version: GLOBAL_TEAM_SCHEMA_VERSION,
    id: newDomainId('teamconv'),
    team_id: validateTeamId(team.id),
    title: requiredText(title, 'conversation title', 160),
    workspace: normalizeWorkspace(workspace),
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
    revision: 1,
  }
}

export function createTeamRunRecord(
  team: GlobalTeamPayload,
  conversation: TeamConversationPayload,
  userMessage: string,
  timestamp = nowTs(),
): TeamRunPayload {
  if (conversation.team_id !== team.id)
    throw new Error('team conversation belongs to a different team')
  return {
    version: GLOBAL_TEAM_SCHEMA_VERSION,
    id: newDomainId('teamrun'),
    team_id: validateTeamId(team.id),
    conversation_id: validateConversationId(conversation.id),
    user_message: requiredText(userMessage, 'team message', 100_000),
    state: 'queued',
    workspace: normalizeWorkspace(conversation.workspace),
    members: team.members
      .filter((member) => member.enabled)
      .map((member) => ({
        id: member.id,
        display_name: member.display_name,
        agent_type: member.agent_type,
        responsibility: member.responsibility,
      })),
    assignments: [],
    final_response: '',
    error: '',
    created_at: timestamp,
    updated_at: timestamp,
    started_at: null,
    finished_at: null,
    revision: 1,
  }
}

export function parseTeamRun(value: unknown): TeamRunPayload {
  const raw = record(value, 'team run')
  const state = String(raw.state ?? '') as TeamRunState
  if (!TEAM_RUN_STATES.has(state)) throw new Error('invalid team run state')
  return {
    model_label: optionalText(raw.model_label, 512),
    ...(raw.retry_of_run_id
      ? { retry_of_run_id: validateRunId(raw.retry_of_run_id) }
      : {}),
    version: positiveInt(raw.version, 'team run version'),
    id: validateRunId(raw.id),
    team_id: validateTeamId(raw.team_id),
    conversation_id: validateConversationId(raw.conversation_id),
    user_message: requiredText(raw.user_message, 'team message', 100_000),
    state,
    workspace: normalizeWorkspace(raw.workspace),
    members: Array.isArray(raw.members) ? raw.members.map(parseRunMember) : [],
    assignments: Array.isArray(raw.assignments)
      ? raw.assignments.map(parseRunAssignment)
      : [],
    final_response: optionalText(raw.final_response, 1_000_000),
    error: optionalText(raw.error, 100_000),
    created_at: finiteNumber(raw.created_at, 'team run created_at'),
    updated_at: finiteNumber(raw.updated_at, 'team run updated_at'),
    started_at: nullableNumber(raw.started_at, 'team run started_at'),
    finished_at: nullableNumber(raw.finished_at, 'team run finished_at'),
    revision: positiveInt(raw.revision, 'team run revision'),
  }
}

const TEAM_RUN_STATES = new Set<TeamRunState>([
  'queued',
  'planning',
  'running',
  'awaiting_user',
  'synthesizing',
  'completed',
  'partial',
  'cancelled',
  'failed',
])

export function validateRunId(value: unknown): string {
  const id = String(value ?? '')
  if (!RUN_ID_RE.test(id)) throw new Error('invalid team run id')
  return id
}

function parseRunMember(value: unknown): TeamRunMemberSnapshot {
  const raw = record(value, 'team run member')
  const id = String(raw.id ?? '')
  if (!MEMBER_ID_RE.test(id)) throw new Error('invalid team member id')
  return {
    id,
    display_name: requiredText(raw.display_name, 'member display name', 80),
    agent_type: requiredText(raw.agent_type, 'member agent type', 80),
    responsibility: optionalText(raw.responsibility, 4000),
  }
}

function parseRunAssignment(value: unknown): TeamRunAssignment {
  const raw = record(value, 'team run assignment')
  const status = String(raw.status ?? '') as TeamRunAssignment['status']
  if (
    !new Set(['pending', 'running', 'completed', 'failed', 'cancelled']).has(
      status,
    )
  )
    throw new Error('invalid team assignment status')
  return {
    dispatched:
      raw.dispatched === true ||
      (raw.dispatched === undefined && Boolean(raw.result)),
    started_at: nullableNumber(raw.started_at, 'assignment started_at'),
    finished_at: nullableNumber(raw.finished_at, 'assignment finished_at'),
    member_id: requiredText(raw.member_id, 'assignment member id', 80),
    task: requiredText(raw.task, 'assignment task', 100_000),
    status,
    result: optionalText(raw.result, 1_000_000),
    error: optionalText(raw.error, 100_000),
  }
}

export function parseGlobalTeam(value: unknown): GlobalTeamPayload {
  const raw = record(value, 'team')
  const members = Array.isArray(raw.members)
    ? raw.members.map(parseGlobalTeamMember)
    : []
  if (members.length < 1 || members.length > GLOBAL_TEAM_MEMBER_LIMIT)
    throw new Error(
      `team members must contain between 1 and ${GLOBAL_TEAM_MEMBER_LIMIT} entries`,
    )
  assertUniqueMemberIdentity(members)
  return {
    version: positiveInt(raw.version, 'team version'),
    id: validateTeamId(raw.id),
    name: requiredText(raw.name, 'team name', 120),
    description: optionalText(raw.description, 1000),
    default_workspace: normalizeWorkspace(raw.default_workspace),
    members,
    created_at: finiteNumber(raw.created_at, 'team created_at'),
    updated_at: finiteNumber(raw.updated_at, 'team updated_at'),
    archived_at: nullableNumber(raw.archived_at, 'team archived_at'),
    revision: positiveInt(raw.revision, 'team revision'),
  }
}

export function parseTeamConversation(value: unknown): TeamConversationPayload {
  const raw = record(value, 'team conversation')
  return {
    version: positiveInt(raw.version, 'conversation version'),
    id: validateConversationId(raw.id),
    team_id: validateTeamId(raw.team_id),
    title: requiredText(raw.title, 'conversation title', 160),
    workspace: normalizeWorkspace(raw.workspace),
    created_at: finiteNumber(raw.created_at, 'conversation created_at'),
    updated_at: finiteNumber(raw.updated_at, 'conversation updated_at'),
    archived_at: nullableNumber(raw.archived_at, 'conversation archived_at'),
    revision: positiveInt(raw.revision, 'conversation revision'),
  }
}

export function validateTeamId(value: unknown): string {
  const id = String(value ?? '')
  if (!TEAM_ID_RE.test(id)) throw new Error('invalid team id')
  return id
}

export function validateConversationId(value: unknown): string {
  const id = String(value ?? '')
  if (!CONVERSATION_ID_RE.test(id))
    throw new Error('invalid team conversation id')
  return id
}

function normalizeMembers(
  input: CreateGlobalTeamMemberInput[],
  timestamp: number,
): GlobalTeamMemberPayload[] {
  if (!Array.isArray(input) || input.length < 1)
    throw new Error('a team requires at least one member')
  if (input.length > GLOBAL_TEAM_MEMBER_LIMIT)
    throw new Error(
      `a team supports at most ${GLOBAL_TEAM_MEMBER_LIMIT} members`,
    )
  const members = input.map((member) => ({
    id: newDomainId('teammember'),
    display_name: requiredText(member.display_name, 'member display name', 80),
    agent_type: requiredText(member.agent_type, 'member agent type', 80),
    responsibility: optionalText(member.responsibility, 4000),
    enabled: true,
    created_at: timestamp,
    updated_at: timestamp,
  }))
  assertUniqueMemberIdentity(members)
  return members
}

function parseGlobalTeamMember(value: unknown): GlobalTeamMemberPayload {
  const raw = record(value, 'team member')
  const id = String(raw.id ?? '')
  if (!MEMBER_ID_RE.test(id)) throw new Error('invalid team member id')
  return {
    id,
    display_name: requiredText(raw.display_name, 'member display name', 80),
    agent_type: requiredText(raw.agent_type, 'member agent type', 80),
    responsibility: optionalText(raw.responsibility, 4000),
    enabled: raw.enabled !== false,
    created_at: finiteNumber(raw.created_at, 'member created_at'),
    updated_at: finiteNumber(raw.updated_at, 'member updated_at'),
  }
}

function assertUniqueMemberIdentity(members: GlobalTeamMemberPayload[]): void {
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const member of members) {
    const folded = member.display_name.toLocaleLowerCase()
    if (ids.has(member.id)) throw new Error('duplicate team member id')
    if (names.has(folded)) throw new Error('duplicate team member display name')
    ids.add(member.id)
    names.add(folded)
  }
}

function normalizeWorkspace(value: unknown): TeamWorkspaceBinding {
  if (value === undefined || value === null) return { kind: 'none' }
  const raw = record(value, 'team workspace')
  if (raw.kind === 'none') return { kind: 'none' }
  if (raw.kind === 'folder')
    return {
      kind: 'folder',
      path: requiredText(raw.path, 'workspace path', 4096),
    }
  if (raw.kind === 'project') {
    const path = optionalText(raw.path, 4096)
    return {
      kind: 'project',
      project_id: requiredText(raw.project_id, 'workspace project id', 512),
      ...(path ? { path } : {}),
    }
  }
  throw new Error('invalid team workspace kind')
}

function newDomainId(
  prefix: 'team' | 'teamconv' | 'teammember' | 'teamrun',
): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label} is required`)
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters`)
  return text
}

function optionalText(value: unknown, max: number): string {
  const text = String(value ?? '').trim()
  if (text.length > max) throw new Error(`text exceeds ${max} characters`)
  return text
}

function finiteNumber(value: unknown, label: string): number {
  const out = Number(value)
  if (!Number.isFinite(out)) throw new Error(`${label} must be finite`)
  return out
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === undefined || value === null
    ? null
    : finiteNumber(value, label)
}

function positiveInt(value: unknown, label: string): number {
  const out = Number(value)
  if (!Number.isSafeInteger(out) || out < 1)
    throw new Error(`${label} must be a positive integer`)
  return out
}
