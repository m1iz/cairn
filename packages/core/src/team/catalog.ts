import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from '../store/atomic-json'
import { withLock } from '../store/file-lock'
import {
  createGlobalTeamRecord,
  createTeamConversationRecord,
  createTeamRunRecord,
  parseGlobalTeam,
  parseTeamConversation,
  parseTeamRun,
  validateConversationId,
  validateRunId,
  validateTeamId,
  type CreateGlobalTeamInput,
  type GlobalTeamPayload,
  type TeamConversationPayload,
  type TeamRunPayload,
  type TeamRunState,
  type TeamWorkspaceBinding,
} from './domain'

/**
 * Global Agent Team catalog.
 *
 * This store intentionally lives beside, not inside, the legacy project-scoped
 * TeamStore. Nothing in the ordinary chat/session runtime reads it until the
 * dedicated Team conversation service is explicitly wired.
 */
export class GlobalTeamCatalog {
  readonly root: string
  readonly teamsDir: string

  constructor(teamRoot: string) {
    this.root = join(teamRoot, 'global-v1')
    this.teamsDir = join(this.root, 'teams')
  }

  async ensure(): Promise<void> {
    await mkdir(this.teamsDir, { recursive: true })
  }

  async listTeams(
    opts: { includeArchived?: boolean } = {},
  ): Promise<GlobalTeamPayload[]> {
    await this.ensure()
    const entries = await readdir(this.teamsDir, { withFileTypes: true })
    const teams = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readTeam(entry.name).catch(() => null)),
    )
    return teams
      .filter((team): team is GlobalTeamPayload => Boolean(team))
      .filter((team) => opts.includeArchived || team.archived_at === null)
      .sort(
        (a, b) => b.updated_at - a.updated_at || a.name.localeCompare(b.name),
      )
  }

  async createTeam(input: CreateGlobalTeamInput): Promise<{
    team: GlobalTeamPayload
    conversation: TeamConversationPayload
  }> {
    const created = createGlobalTeamRecord(input)
    const teamDir = this.teamDir(created.team.id)
    await mkdir(this.conversationsDir(created.team.id), { recursive: true })
    try {
      await writeJsonAtomic(this.teamFile(created.team.id), created.team)
      await writeJsonAtomic(
        this.conversationFile(created.team.id, created.conversation.id),
        created.conversation,
      )
      return created
    } catch (error) {
      await rm(teamDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  async getTeam(teamId: string): Promise<GlobalTeamPayload | null> {
    const safe = validateTeamId(teamId)
    if (!existsSync(this.teamFile(safe))) return null
    return this.readTeam(safe)
  }

  async listConversations(
    teamId: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<TeamConversationPayload[]> {
    const safe = validateTeamId(teamId)
    const dir = this.conversationsDir(safe)
    if (!existsSync(dir)) return []
    const entries = await readdir(dir, { withFileTypes: true })
    const conversations = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) =>
          this.readConversation(safe, entry.name.slice(0, -5)).catch(
            () => null,
          ),
        ),
    )
    return conversations
      .filter((conversation): conversation is TeamConversationPayload =>
        Boolean(conversation),
      )
      .filter(
        (conversation) =>
          opts.includeArchived || conversation.archived_at === null,
      )
      .sort((a, b) => b.updated_at - a.updated_at)
  }

  async createConversation(
    teamId: string,
    input: { title: string; workspace?: TeamWorkspaceBinding | null },
  ): Promise<TeamConversationPayload> {
    const safe = validateTeamId(teamId)
    return withLock(this.teamFile(safe), async () => {
      const team = await this.requireTeam(safe)
      if (team.archived_at !== null)
        throw new Error('cannot add a conversation to an archived team')
      const conversation = createTeamConversationRecord(
        team,
        input.title,
        input.workspace ?? team.default_workspace,
      )
      await writeJsonAtomic(
        this.conversationFile(safe, conversation.id),
        conversation,
      )
      await writeJsonAtomic(this.teamFile(safe), {
        ...team,
        updated_at: conversation.created_at,
        revision: team.revision + 1,
      })
      return conversation
    })
  }

  async getConversation(
    teamId: string,
    conversationId: string,
  ): Promise<TeamConversationPayload | null> {
    const safeTeam = validateTeamId(teamId)
    const safeConversation = validateConversationId(conversationId)
    if (!existsSync(this.conversationFile(safeTeam, safeConversation)))
      return null
    return this.readConversation(safeTeam, safeConversation)
  }

  async createRun(
    teamId: string,
    conversationId: string,
    userMessage: string,
  ): Promise<TeamRunPayload> {
    const team = await this.requireTeam(teamId)
    const conversation = await this.getConversation(team.id, conversationId)
    if (!conversation)
      throw new Error(`unknown team conversation: ${conversationId}`)
    const run = createTeamRunRecord(team, conversation, userMessage)
    await mkdir(this.runsDir(team.id, conversation.id), { recursive: true })
    await writeJsonAtomic(this.runFile(team.id, conversation.id, run.id), run)
    return run
  }

  async listRuns(
    teamId: string,
    conversationId: string,
  ): Promise<TeamRunPayload[]> {
    const safeTeam = validateTeamId(teamId)
    const safeConversation = validateConversationId(conversationId)
    const dir = this.runsDir(safeTeam, safeConversation)
    if (!existsSync(dir)) return []
    const entries = await readdir(dir, { withFileTypes: true })
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) =>
          this.getRun(
            safeTeam,
            safeConversation,
            entry.name.slice(0, -5),
          ).catch(() => null),
        ),
    )
    return runs
      .filter((run): run is TeamRunPayload => Boolean(run))
      .sort((a, b) => a.created_at - b.created_at)
  }

  async getRun(
    teamId: string,
    conversationId: string,
    runId: string,
  ): Promise<TeamRunPayload | null> {
    const path = this.runFile(teamId, conversationId, runId)
    if (!existsSync(path)) return null
    const run = await readJson(path, null as never, { validate: parseTeamRun })
    if (run.team_id !== teamId || run.conversation_id !== conversationId)
      throw new Error('team run belongs to a different conversation')
    return run
  }

  async updateRun(
    teamId: string,
    conversationId: string,
    runId: string,
    mutate: (run: TeamRunPayload) => TeamRunPayload,
  ): Promise<TeamRunPayload> {
    const path = this.runFile(teamId, conversationId, runId)
    return withLock(path, async () => {
      const current = await this.getRun(teamId, conversationId, runId)
      if (!current) throw new Error(`unknown team run: ${runId}`)
      const next = parseTeamRun(mutate(structuredClone(current)))
      if (
        next.id !== current.id ||
        next.team_id !== current.team_id ||
        next.conversation_id !== current.conversation_id
      )
        throw new Error('team run identity is immutable')
      assertRunTransition(current.state, next.state)
      const saved = {
        ...next,
        updated_at: Date.now() / 1000,
        revision: current.revision + 1,
      }
      await writeJsonAtomic(path, saved)
      return saved
    })
  }

  private async requireTeam(teamId: string): Promise<GlobalTeamPayload> {
    const team = await this.getTeam(teamId)
    if (!team) throw new Error(`unknown team: ${teamId}`)
    return team
  }

  private async readTeam(teamId: string): Promise<GlobalTeamPayload> {
    const path = this.teamFile(validateTeamId(teamId))
    return readJson(path, null as never, { validate: parseGlobalTeam })
  }

  private async readConversation(
    teamId: string,
    conversationId: string,
  ): Promise<TeamConversationPayload> {
    const path = this.conversationFile(
      validateTeamId(teamId),
      validateConversationId(conversationId),
    )
    const conversation = await readJson(path, null as never, {
      validate: parseTeamConversation,
    })
    if (conversation.team_id !== teamId)
      throw new Error('team conversation belongs to a different team')
    return conversation
  }

  private teamDir(teamId: string): string {
    return join(this.teamsDir, validateTeamId(teamId))
  }

  private teamFile(teamId: string): string {
    return join(this.teamDir(teamId), 'team.json')
  }

  private conversationsDir(teamId: string): string {
    return join(this.teamDir(teamId), 'conversations')
  }

  private conversationFile(teamId: string, conversationId: string): string {
    return join(
      this.conversationsDir(teamId),
      `${validateConversationId(conversationId)}.json`,
    )
  }

  runtimeDir(teamId: string, conversationId: string): string {
    return join(
      this.teamDir(validateTeamId(teamId)),
      'runtime',
      validateConversationId(conversationId),
    )
  }

  private runsDir(teamId: string, conversationId: string): string {
    return join(
      this.teamDir(validateTeamId(teamId)),
      'runs',
      validateConversationId(conversationId),
    )
  }

  private runFile(
    teamId: string,
    conversationId: string,
    runId: string,
  ): string {
    return join(
      this.runsDir(
        validateTeamId(teamId),
        validateConversationId(conversationId),
      ),
      `${validateRunId(runId)}.json`,
    )
  }
}

const RUN_TRANSITIONS: Record<TeamRunState, Set<TeamRunState>> = {
  queued: new Set(['planning', 'cancelled', 'failed']),
  planning: new Set(['running', 'cancelled', 'failed']),
  running: new Set([
    'awaiting_user',
    'synthesizing',
    'partial',
    'cancelled',
    'failed',
  ]),
  awaiting_user: new Set(['running', 'cancelled', 'failed']),
  synthesizing: new Set(['completed', 'partial', 'cancelled', 'failed']),
  completed: new Set(),
  partial: new Set(),
  cancelled: new Set(),
  failed: new Set(),
}

function assertRunTransition(from: TeamRunState, to: TeamRunState): void {
  if (from === to) return
  if (!RUN_TRANSITIONS[from].has(to))
    throw new Error(`invalid team run transition: ${from} -> ${to}`)
}
