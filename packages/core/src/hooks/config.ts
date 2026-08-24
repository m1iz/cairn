import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readJson, writeJsonAtomic } from '../store/atomic-json'
import {
  HOOK_EVENT_NAMES,
  type HookDiagnostic,
  type HookGroup,
  type HookSnapshot,
  type HookSource,
  type HooksConfig,
  type ProjectHookTrustStatus,
  type ResolvedHookGroup,
} from './models'
import {
  defaultHooksConfig,
  parseHooksConfig,
  serializeHooksConfig,
} from './schema'

export const HOOKS_CONFIG_FILE = 'hooks_config.json'

const PROJECT_TRUST_FILE = join('hooks', 'project-trust.json')
const SOURCE_RANK: Record<
  'global' | 'project' | 'project-local' | 'session',
  number
> = {
  global: 100,
  project: 200,
  'project-local': 300,
  session: 400,
}

interface ProjectTrustRecord {
  digest: string
  trustedAt: string | null
  revokedAt: string | null
}

interface ProjectTrustFile {
  version: 1
  records: Record<string, ProjectTrustRecord>
}

interface SessionHookSource {
  sourceId: string
  raw: unknown
}

export class ProjectHookTrustStore {
  readonly stateRoot: string
  readonly path: string

  constructor(opts: { stateRoot: string }) {
    this.stateRoot = resolve(opts.stateRoot)
    this.path = join(this.stateRoot, PROJECT_TRUST_FILE)
  }

  async status(projectRoot: string): Promise<ProjectHookTrustStatus> {
    const canonicalRoot = await canonicalProjectRoot(projectRoot)
    const digest = await projectHooksDigest(canonicalRoot)
    const file = await this.read()
    const record = file.records[canonicalRoot]
    let status: ProjectHookTrustStatus['status'] = 'untrusted'
    if (record && !record.revokedAt)
      status = record.digest === digest ? 'trusted' : 'stale'
    return { canonicalRoot, digest, status }
  }

  async set(opts: {
    projectRoot: string
    expectedDigest: string
    trusted: boolean
  }): Promise<ProjectHookTrustStatus> {
    const current = await this.status(opts.projectRoot)
    if (current.digest !== opts.expectedDigest)
      throw new Error(
        'project hooks digest changed before trust could be saved',
      )
    const file = await this.read()
    const now = new Date().toISOString()
    file.records[current.canonicalRoot] = opts.trusted
      ? { digest: current.digest, trustedAt: now, revokedAt: null }
      : {
          digest: current.digest,
          trustedAt: file.records[current.canonicalRoot]?.trustedAt ?? null,
          revokedAt: now,
        }
    await writeJsonAtomic(this.path, file)
    return { ...current, status: opts.trusted ? 'trusted' : 'untrusted' }
  }

  private async read(): Promise<ProjectTrustFile> {
    const loaded = await readJson<unknown>(this.path, null)
    const data = objectOrNull(loaded)
    const recordsRaw = objectOrNull(data?.records)
    const records: Record<string, ProjectTrustRecord> = {}
    for (const [root, value] of Object.entries(recordsRaw ?? {})) {
      const record = objectOrNull(value)
      if (!record || typeof record.digest !== 'string') continue
      records[root] = {
        digest: record.digest,
        trustedAt:
          typeof record.trustedAt === 'string' ? record.trustedAt : null,
        revokedAt:
          typeof record.revokedAt === 'string' ? record.revokedAt : null,
      }
    }
    return { version: 1, records }
  }
}

export class HookSessionRegistry {
  private readonly sourcesBySession = new Map<string, SessionHookSource[]>()

  register(
    sessionId: string,
    config: unknown,
    opts: { sourceId?: string } = {},
  ): void {
    const cleanSessionId = String(sessionId).trim()
    if (!cleanSessionId)
      throw new Error('sessionId is required for session hooks')
    const sourceId = String(opts.sourceId ?? 'session').trim() || 'session'
    const sources = [...(this.sourcesBySession.get(cleanSessionId) ?? [])]
    const next = { sourceId, raw: config }
    const index = sources.findIndex((source) => source.sourceId === sourceId)
    if (index >= 0) sources[index] = next
    else sources.push(next)
    this.sourcesBySession.set(cleanSessionId, sources)
  }

  clear(sessionId: string): void {
    this.sourcesBySession.delete(String(sessionId).trim())
  }

  sources(sessionId: string | null | undefined): SessionHookSource[] {
    if (!sessionId) return []
    return [...(this.sourcesBySession.get(String(sessionId).trim()) ?? [])]
  }
}

export class HookSourceResolver {
  readonly stateRoot: string
  readonly globalConfigPath: string
  readonly trustStore: ProjectHookTrustStore
  readonly sessionRegistry: HookSessionRegistry

  constructor(opts: {
    stateRoot: string
    sessionRegistry?: HookSessionRegistry
  }) {
    this.stateRoot = resolve(opts.stateRoot)
    this.globalConfigPath = join(this.stateRoot, HOOKS_CONFIG_FILE)
    this.trustStore = new ProjectHookTrustStore({ stateRoot: this.stateRoot })
    this.sessionRegistry = opts.sessionRegistry ?? new HookSessionRegistry()
  }

  async resolve(
    opts: { projectRoot?: string | null; sessionId?: string | null } = {},
  ): Promise<HookSnapshot> {
    const diagnostics: HookDiagnostic[] = []
    const sources: HookSource[] = []
    const effective = new Map<string, ResolvedHookGroup>()

    const globalRaw = await readJson<unknown>(this.globalConfigPath, null, {
      onCorrupt: (info) =>
        diagnostics.push({
          code: 'corrupt_config',
          path: info.path,
          message: `Corrupt hooks config preserved at ${info.backupPath}`,
        }),
    })
    const globalParsed = parseHooksConfig(globalRaw, { sourceKind: 'global' })
    diagnostics.push(...globalParsed.diagnostics)
    const globalSource = createHookSource({
      id: 'global',
      kind: 'global',
      path: this.globalConfigPath,
      revision: digestValue(serializeHooksConfig(globalParsed.config)),
      active: globalParsed.config.enabled,
      blockedReason: globalParsed.config.enabled ? null : 'hooks_disabled',
    })
    sources.push(globalSource)
    if (globalSource.active)
      mergeResolvedGroups(effective, globalParsed.config, globalSource)

    let projectTrust: ProjectHookTrustStatus | null = null
    const projectRoot = opts.projectRoot ? resolve(opts.projectRoot) : null
    if (projectRoot && globalParsed.config.projectHooks.enabled) {
      projectTrust = await this.trustStore.status(projectRoot)
      const projectFiles: Array<{
        id: string
        kind: 'project' | 'project-local'
        path: string
      }> = [
        {
          id: 'project',
          kind: 'project',
          path: join(projectTrust.canonicalRoot, '.cairn', 'settings.json'),
        },
        {
          id: 'project-local',
          kind: 'project-local',
          path: join(
            projectTrust.canonicalRoot,
            '.cairn',
            'settings.local.json',
          ),
        },
      ]
      for (const descriptor of projectFiles) {
        const loaded = await readProjectConfig(descriptor.path, descriptor.kind)
        if (!loaded) continue
        diagnostics.push(...loaded.diagnostics)
        const trustBlocked =
          projectTrust.status === 'trusted'
            ? null
            : projectTrust.status === 'stale'
              ? 'project_trust_stale'
              : 'project_untrusted'
        const active =
          globalSource.active && loaded.config.enabled && trustBlocked === null
        const source = createHookSource({
          ...descriptor,
          revision: loaded.revision,
          active,
          blockedReason: !globalSource.active
            ? 'hooks_disabled'
            : !loaded.config.enabled
              ? 'source_disabled'
              : trustBlocked,
        })
        sources.push(source)
        if (source.active) mergeResolvedGroups(effective, loaded.config, source)
      }
    }

    const sessionSources = this.sessionRegistry.sources(opts.sessionId)
    for (let index = 0; index < sessionSources.length; index++) {
      const registered = sessionSources[index]!
      const parsed = parseHooksConfig(registered.raw, {
        sourceKind: 'session',
      })
      diagnostics.push(
        ...parsed.diagnostics.map((item) => ({
          ...item,
          path: `session.${registered.sourceId}.${item.path}`,
        })),
      )
      const source = createHookSource({
        id: `session:${registered.sourceId}`,
        kind: 'session',
        path: `session://${String(opts.sessionId ?? '')}/${registered.sourceId}`,
        revision: digestValue(serializeHooksConfig(parsed.config)),
        active: globalSource.active && parsed.config.enabled,
        blockedReason:
          globalSource.active && parsed.config.enabled
            ? null
            : 'hooks_disabled',
      })
      source.rank += index
      sources.push(source)
      if (source.active) mergeResolvedGroups(effective, parsed.config, source)
    }

    const groups = orderedResolvedGroups(effective)
    const config = effectiveConfig(globalParsed.config, groups)
    const revision = digestValue({
      config: serializeHooksConfig(config),
      sources: sources.map((source) => ({
        id: source.id,
        revision: source.revision,
        active: source.active,
      })),
    })
    return deepFreeze({
      revision,
      config,
      groups,
      sources,
      diagnostics,
      projectTrust,
    })
  }
}

export class HookSnapshotStore {
  private readonly resolver: HookSourceResolver
  private readonly reviewCandidate:
    | ((
        previous: HookSnapshot | null,
        candidate: HookSnapshot,
        scope: { projectRoot?: string | null; sessionId?: string | null },
      ) => boolean | Promise<boolean>)
    | null
  private readonly accepted = new Map<string, HookSnapshot>()

  constructor(opts: {
    resolver: HookSourceResolver
    reviewCandidate?:
      | ((
          previous: HookSnapshot | null,
          candidate: HookSnapshot,
          scope: { projectRoot?: string | null; sessionId?: string | null },
        ) => boolean | Promise<boolean>)
      | null
  }) {
    this.resolver = opts.resolver
    this.reviewCandidate = opts.reviewCandidate ?? null
  }

  async get(
    opts: { projectRoot?: string | null; sessionId?: string | null } = {},
  ): Promise<HookSnapshot> {
    const key = `${resolve(opts.projectRoot ?? '')}\0${String(opts.sessionId ?? '')}`
    const previous = this.accepted.get(key) ?? null
    const candidate = await this.resolver.resolve(opts)
    if (!previous) {
      this.accepted.set(key, candidate)
      return candidate
    }
    if (previous.revision === candidate.revision) return previous
    let accepted = true
    try {
      if (this.reviewCandidate)
        accepted = await this.reviewCandidate(previous, candidate, opts)
    } catch (error) {
      return rejectedSnapshot(
        previous,
        'candidate_review_failed',
        error instanceof Error ? error.message : String(error),
      )
    }
    if (!accepted)
      return rejectedSnapshot(
        previous,
        'candidate_rejected',
        `Hook snapshot candidate ${candidate.revision} was rejected`,
      )
    this.accepted.set(key, candidate)
    return candidate
  }

  accept(
    snapshot: HookSnapshot,
    opts: { projectRoot?: string | null; sessionId?: string | null } = {},
  ): void {
    this.accepted.set(snapshotKey(opts), snapshot)
  }
}

function snapshotKey(opts: {
  projectRoot?: string | null
  sessionId?: string | null
}): string {
  return `${resolve(opts.projectRoot ?? '')}\0${String(opts.sessionId ?? '')}`
}

async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  const requested = resolve(projectRoot)
  try {
    return await realpath(requested)
  } catch {
    return requested
  }
}

async function projectHooksDigest(canonicalRoot: string): Promise<string> {
  const hash = createHash('sha256')
  for (const name of ['settings.json', 'settings.local.json']) {
    const path = join(canonicalRoot, '.cairn', name)
    hash.update(name)
    hash.update('\0')
    try {
      hash.update(await readFile(path))
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : ''
      if (code !== 'ENOENT') throw error
      hash.update('<missing>')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function readProjectConfig(
  path: string,
  sourceKind: 'project' | 'project-local',
): Promise<{
  config: HooksConfig
  diagnostics: HookDiagnostic[]
  revision: string
} | null> {
  if (!existsSync(path)) return null
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return {
      config: { ...defaultHooksConfig(), enabled: false },
      diagnostics: [
        {
          code: 'project_config_read_failed',
          path,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      revision: digestValue({ path, error: String(error) }),
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text || '{}')
  } catch (error) {
    return {
      config: { ...defaultHooksConfig(), enabled: false },
      diagnostics: [
        {
          code: 'corrupt_project_config',
          path,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      revision: digestText(text),
    }
  }
  const parsed = parseHooksConfig(raw, { sourceKind })
  return { ...parsed, revision: digestText(text) }
}

function createHookSource(opts: {
  id: string
  kind: 'global' | 'project' | 'project-local' | 'session'
  path: string
  revision: string
  active: boolean
  blockedReason: string | null
}): HookSource {
  return {
    id: opts.id,
    kind: opts.kind,
    rank: SOURCE_RANK[opts.kind],
    path: opts.path,
    readonly: opts.kind !== 'global',
    revision: opts.revision,
    active: opts.active,
    blockedReason: opts.blockedReason,
  }
}

function mergeResolvedGroups(
  target: Map<string, ResolvedHookGroup>,
  config: HooksConfig,
  source: HookSource,
): void {
  for (const eventName of HOOK_EVENT_NAMES) {
    for (const group of config.hooks[eventName] ?? []) {
      if (!group.enabled) continue
      const key = `${eventName}\0${group.id}`
      if (target.has(key)) target.delete(key)
      target.set(key, {
        eventName,
        group: cloneHookGroup(group),
        source: { ...source },
      })
    }
  }
}

function orderedResolvedGroups(
  groups: Map<string, ResolvedHookGroup>,
): ResolvedHookGroup[] {
  const values = [...groups.values()]
  return HOOK_EVENT_NAMES.flatMap((eventName) =>
    values.filter((group) => group.eventName === eventName),
  )
}

function effectiveConfig(
  globalConfig: HooksConfig,
  groups: ResolvedHookGroup[],
): HooksConfig {
  const hooks: HooksConfig['hooks'] = {}
  for (const resolvedGroup of groups) {
    const eventGroups = hooks[resolvedGroup.eventName] ?? []
    eventGroups.push(cloneHookGroup(resolvedGroup.group))
    hooks[resolvedGroup.eventName] = eventGroups
  }
  return {
    version: 2,
    enabled: globalConfig.enabled,
    projectHooks: { enabled: globalConfig.projectHooks.enabled },
    policy: {
      ...globalConfig.policy,
      command: {
        ...globalConfig.policy.command,
        allowedEnv: [...globalConfig.policy.command.allowedEnv],
      },
      http: {
        ...globalConfig.policy.http,
        allowedUrlPatterns: [...globalConfig.policy.http.allowedUrlPatterns],
        allowedEnv: [...globalConfig.policy.http.allowedEnv],
      },
      prompt: { ...globalConfig.policy.prompt },
      agent: { ...globalConfig.policy.agent },
    },
    hooks,
  }
}

function cloneHookGroup(group: HookGroup): HookGroup {
  return {
    ...group,
    handlers: group.handlers.map((handler) => {
      if (handler.type === 'command')
        return {
          ...handler,
          args: [...handler.args],
          allowedEnv: [...handler.allowedEnv],
        }
      if (handler.type === 'http')
        return {
          ...handler,
          headers: { ...handler.headers },
          allowedEnv: [...handler.allowedEnv],
        }
      return { ...handler }
    }),
  }
}

function digestValue(value: unknown): string {
  return digestText(JSON.stringify(sortKeysDeep(value)))
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
  }
  return out
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value))
    return value
  for (const child of Object.values(value as Record<string, unknown>))
    deepFreeze(child)
  return Object.freeze(value)
}

function rejectedSnapshot(
  previous: HookSnapshot,
  code: string,
  message: string,
): HookSnapshot {
  return deepFreeze({
    ...previous,
    diagnostics: [...previous.diagnostics, { code, path: 'snapshot', message }],
  })
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
