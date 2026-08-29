import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  parsePermissionRules,
  type PermissionRuleDiagnostics,
  type PermissionRuleInput,
} from '../permissions/rules'
import type { SoftGitRewindMode } from '../checkpoints/soft-git-rewind'

export const LOCAL_CONFIG_FILE = 'cairn.local.json'

export interface WebUIPreferences {
  host: string
  port: number
  openBrowser: boolean
}

export type PromptProfile = 'classic' | 'neutral' | 'technical'

export interface PromptPreferences {
  profile: PromptProfile
}

export interface PermissionPreferences {
  rules: PermissionRuleInput[]
}

export interface WorkspacePreferences {
  fileCheckpoints: { enabled: boolean }
  gitRewind: { mode: SoftGitRewindMode }
}

export type HybridMemoryMode = 'off' | 'eval' | 'on'

export interface MemoryEmbeddingPreferences {
  provider: 'tei'
  endpoint: string
  model: string
  dimensions: number
  timeoutMs: number
}

export interface MemoryVectorDatabasePreferences {
  provider: 'postgres'
  connectionString: string
  secretsFile?: string
}

export interface MemoryRerankerPreferences {
  provider: 'tei'
  endpoint: string
  model: string
  timeoutMs: number
}

export interface MemoryPreferences {
  hybridMemory: HybridMemoryMode
  embedding?: MemoryEmbeddingPreferences
  vectorDatabase?: MemoryVectorDatabasePreferences
  reranker?: MemoryRerankerPreferences
  evaluationReceiptPath?: string
}

export type CodeIntelligenceMode = 'off' | 'eval' | 'on'

export interface CodeIntelligencePreferences {
  mode: CodeIntelligenceMode
}

export interface LocalConfig {
  webui: WebUIPreferences
  prompt: PromptPreferences
  memory: MemoryPreferences
  codeIntelligence: CodeIntelligencePreferences
  workspace: WorkspacePreferences
  permissions: PermissionPreferences
}

export type LocalConfigInput = Omit<
  LocalConfig,
  'memory' | 'codeIntelligence'
> & {
  memory?: MemoryPreferences
  codeIntelligence?: CodeIntelligencePreferences
}

export interface LocalConfigBackup {
  path: string
  bytes: number
  updatedAt: number
}

export interface LocalConfigDiagnostics {
  path: string
  exists: boolean
  status: 'missing' | 'ok' | 'corrupt'
  error: string
  permissions: PermissionRuleDiagnostics
  corruptBackups: LocalConfigBackup[]
}

function defaultLocalConfig(): LocalConfig {
  return {
    webui: { host: '127.0.0.1', port: 8765, openBrowser: false },
    prompt: { profile: 'technical' },
    memory: { hybridMemory: 'off' },
    codeIntelligence: { mode: 'off' },
    workspace: {
      fileCheckpoints: { enabled: false },
      gitRewind: { mode: 'off' },
    },
    permissions: { rules: [] },
  }
}

function objectOrEmpty(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

function validPort(value: unknown, fallback: number): number {
  const port =
    typeof value === 'number'
      ? Math.trunc(value)
      : Number.parseInt(String(value), 10)
  return Number.isFinite(port) && port >= 1 && port <= 65535 ? port : fallback
}

export function parseLocalConfig(
  raw: Record<string, any> | null | undefined,
): LocalConfig {
  const data = objectOrEmpty(raw)
  const webui = objectOrEmpty(data.webui)
  const prompt = objectOrEmpty(data.prompt)
  const memory = objectOrEmpty(data.memory)
  const codeIntelligence = objectOrEmpty(
    data.codeIntelligence ?? data.code_intelligence,
  )
  const workspace = objectOrEmpty(data.workspace)
  const fileCheckpoints = objectOrEmpty(
    workspace.fileCheckpoints ?? workspace.file_checkpoints,
  )
  const gitRewind = objectOrEmpty(workspace.gitRewind ?? workspace.git_rewind)
  const permissions = objectOrEmpty(data.permissions)
  return {
    webui: {
      host: String(webui.host || '127.0.0.1'),
      port: validPort(webui.port, 8765),
      openBrowser: Boolean(webui.openBrowser ?? webui.open_browser ?? false),
    },
    prompt: {
      profile: normalizePromptProfile(prompt.profile),
    },
    memory: {
      hybridMemory: normalizeHybridMemoryMode(
        memory.hybridMemory ?? memory.hybrid_memory,
      ),
      ...parseMemoryEmbedding(memory.embedding),
      ...parseMemoryVectorDatabase(
        memory.vectorDatabase ?? memory.vector_database,
      ),
      ...parseMemoryReranker(memory.reranker),
      ...optionalStringProperty(
        'evaluationReceiptPath',
        memory.evaluationReceiptPath ?? memory.evaluation_receipt_path,
      ),
    },
    codeIntelligence: {
      mode: normalizeCodeIntelligenceMode(codeIntelligence.mode),
    },
    workspace: {
      fileCheckpoints: {
        enabled: Boolean(fileCheckpoints.enabled ?? false),
      },
      gitRewind: { mode: normalizeSoftGitRewindMode(gitRewind.mode) },
    },
    permissions: {
      rules: Array.isArray(permissions.rules)
        ? (permissions.rules.filter(
            (item) => item && typeof item === 'object' && !Array.isArray(item),
          ) as PermissionRuleInput[])
        : [],
    },
  }
}

export function localConfigPath(root: string): string {
  return join(resolve(root), LOCAL_CONFIG_FILE)
}

export async function loadLocalConfig(
  root: string,
  opts: { preserveCorrupt?: boolean } = {},
): Promise<LocalConfig> {
  const path = localConfigPath(root)
  if (!existsSync(path)) return defaultLocalConfig()
  try {
    return parseLocalConfig(JSON.parse((await readFile(path, 'utf8')) || '{}'))
  } catch {
    if (opts.preserveCorrupt !== false) await preserveCorruptLocalConfig(path)
    return defaultLocalConfig()
  }
}

export async function saveLocalConfig(
  root: string,
  config: LocalConfigInput,
): Promise<string> {
  const path = localConfigPath(root)
  const payload = {
    webui: {
      host: config.webui.host,
      port: config.webui.port,
      openBrowser: config.webui.openBrowser,
    },
    prompt: {
      profile: normalizePromptProfile(config.prompt?.profile),
    },
    memory: {
      hybridMemory: normalizeHybridMemoryMode(config.memory?.hybridMemory),
      ...(config.memory?.embedding
        ? { embedding: normalizeMemoryEmbedding(config.memory.embedding) }
        : {}),
      ...(config.memory?.vectorDatabase
        ? {
            vectorDatabase: normalizeMemoryVectorDatabase(
              config.memory.vectorDatabase,
            ),
          }
        : {}),
      ...(config.memory?.reranker
        ? { reranker: normalizeMemoryReranker(config.memory.reranker) }
        : {}),
      ...optionalStringProperty(
        'evaluationReceiptPath',
        config.memory?.evaluationReceiptPath,
      ),
    },
    codeIntelligence: {
      mode: normalizeCodeIntelligenceMode(config.codeIntelligence?.mode),
    },
    workspace: {
      fileCheckpoints: {
        enabled: Boolean(config.workspace?.fileCheckpoints?.enabled ?? false),
      },
      gitRewind: {
        mode: normalizeSoftGitRewindMode(config.workspace?.gitRewind?.mode),
      },
    },
    permissions: {
      rules: Array.isArray(config.permissions?.rules)
        ? config.permissions.rules
        : [],
    },
  }
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(
    dirname(path),
    `.${LOCAL_CONFIG_FILE}.${randomUUID().replace(/-/g, '')}.tmp`,
  )
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
  return path
}

export function normalizePromptProfile(value: unknown): PromptProfile {
  return value === 'classic' || value === 'neutral' || value === 'technical'
    ? value
    : 'technical'
}

export function normalizeSoftGitRewindMode(value: unknown): SoftGitRewindMode {
  return value === 'eval' || value === 'on' ? value : 'off'
}

export function normalizeHybridMemoryMode(value: unknown): HybridMemoryMode {
  return value === 'eval' || value === 'on' ? value : 'off'
}

function parseMemoryEmbedding(
  value: unknown,
): { embedding: MemoryEmbeddingPreferences } | Record<string, never> {
  const input = objectOrEmpty(value)
  if (input.provider !== 'tei') return {}
  return { embedding: normalizeMemoryEmbedding(input) }
}

function normalizeMemoryEmbedding(
  value: Partial<MemoryEmbeddingPreferences>,
): MemoryEmbeddingPreferences {
  return {
    provider: 'tei',
    endpoint: String(value.endpoint || 'http://127.0.0.1:8088').replace(
      /\/+$/,
      '',
    ),
    model: String(value.model || 'intfloat/multilingual-e5-small'),
    dimensions: Math.min(
      8_192,
      Math.max(1, Math.trunc(Number(value.dimensions) || 384)),
    ),
    timeoutMs: Math.min(
      120_000,
      Math.max(100, Math.trunc(Number(value.timeoutMs) || 10_000)),
    ),
  }
}

function parseMemoryVectorDatabase(
  value: unknown,
): { vectorDatabase: MemoryVectorDatabasePreferences } | Record<string, never> {
  const input = objectOrEmpty(value)
  if (input.provider !== 'postgres' || !String(input.connectionString || ''))
    return {}
  return { vectorDatabase: normalizeMemoryVectorDatabase(input) }
}

function normalizeMemoryVectorDatabase(
  value: Partial<MemoryVectorDatabasePreferences>,
): MemoryVectorDatabasePreferences {
  return {
    provider: 'postgres',
    connectionString: String(value.connectionString || ''),
    ...optionalStringProperty('secretsFile', value.secretsFile),
  }
}

function parseMemoryReranker(
  value: unknown,
): { reranker: MemoryRerankerPreferences } | Record<string, never> {
  const input = objectOrEmpty(value)
  if (input.provider !== 'tei') return {}
  return { reranker: normalizeMemoryReranker(input) }
}

function normalizeMemoryReranker(
  value: Partial<MemoryRerankerPreferences>,
): MemoryRerankerPreferences {
  return {
    provider: 'tei',
    endpoint: String(value.endpoint || 'http://127.0.0.1:8089').replace(
      /\/+$/,
      '',
    ),
    model: String(value.model || 'BAAI/bge-reranker-v2-m3'),
    timeoutMs: Math.min(
      30_000,
      Math.max(100, Math.trunc(Number(value.timeoutMs) || 800)),
    ),
  }
}

function optionalStringProperty<K extends string>(
  key: K,
  value: unknown,
): { [P in K]?: string } {
  const normalized = String(value ?? '').trim()
  return normalized ? ({ [key]: normalized } as { [P in K]: string }) : {}
}

export function normalizeCodeIntelligenceMode(
  value: unknown,
): CodeIntelligenceMode {
  return value === 'eval' || value === 'on' ? value : 'off'
}

export function mergeWebuiOverrides(
  config: LocalConfig,
  overrides: {
    host?: string | null
    port?: number | null
    openBrowser?: boolean | null
  } = {},
): WebUIPreferences {
  return {
    host: String(overrides.host || config.webui.host || '127.0.0.1'),
    port: validPort(overrides.port ?? config.webui.port, 8765),
    openBrowser:
      overrides.openBrowser === null || overrides.openBrowser === undefined
        ? config.webui.openBrowser
        : Boolean(overrides.openBrowser),
  }
}

export async function localConfigDiagnostics(
  root: string,
): Promise<LocalConfigDiagnostics> {
  const path = localConfigPath(root)
  const exists = existsSync(path)
  let status: LocalConfigDiagnostics['status'] = 'missing'
  let error = ''
  if (exists) {
    try {
      const raw = JSON.parse((await readFile(path, 'utf8')) || '{}')
      const parsed = parseLocalConfig(raw)
      const permissionDiagnostics = parsePermissionRules(
        parsed.permissions.rules,
      ).diagnostics
      status = 'ok'
      return {
        path,
        exists,
        status,
        error,
        permissions: permissionDiagnostics,
        corruptBackups: await listCorruptBackups(path),
      }
    } catch (err) {
      status = 'corrupt'
      error = err instanceof Error ? err.message : String(err)
    }
  }
  return {
    path,
    exists,
    status,
    error,
    permissions: parsePermissionRules([]).diagnostics,
    corruptBackups: await listCorruptBackups(path),
  }
}

async function preserveCorruptLocalConfig(path: string): Promise<void> {
  if (!existsSync(path)) return
  const seconds = Math.trunc(Date.now() / 1000)
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8)
  await rename(path, `${path}.corrupt-${seconds}-${suffix}`).catch(() => {})
}

async function listCorruptBackups(path: string): Promise<LocalConfigBackup[]> {
  const parent = dirname(path)
  const prefix = `${LOCAL_CONFIG_FILE}.corrupt-`
  const names = await readdir(parent).catch(() => [])
  const backups: LocalConfigBackup[] = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const fullPath = join(parent, name)
    const info = await stat(fullPath).catch(() => null)
    if (!info) continue
    backups.push({
      path: fullPath,
      bytes: info.size,
      updatedAt: info.mtimeMs / 1000,
    })
  }
  backups.sort((a, b) => b.updatedAt - a.updatedAt)
  return backups.slice(0, 10)
}
