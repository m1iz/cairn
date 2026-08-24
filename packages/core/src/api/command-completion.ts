import type { CommandCompletion } from '../commands/types'

interface CompletionModelConfig {
  models: Array<{
    entryId: string
    modelId: string
    effectiveDisplayName: string
    provider: string
  }>
  current: { reasoningEfforts: readonly string[] } | null
}

interface CompletionSkill {
  name: string
  description: string
  status: string
}

interface CompletionTool {
  name: string
  description: string
  source: 'builtin' | 'mcp'
}

interface CompletionWorkspaceResult {
  entries: Array<{ path: string; name: string; kind: string }>
}

export interface CommandCompletionSession {
  id: string
  title: string
  preview?: string
}

export interface CoreCommandCompletionDeps {
  getModelConfig(): Promise<CompletionModelConfig>
  listSessions(): CommandCompletionSession[]
  listSkills(): CompletionSkill[]
  listTools(): CompletionTool[]
  searchWorkspace(input: {
    sessionId: string
    query: string
    limit: number
  }): Promise<CompletionWorkspaceResult>
}

export async function completeCoreCommand(
  name: string,
  rawArgs: string,
  sessionId: string,
  deps: CoreCommandCompletionDeps,
): Promise<CommandCompletion[]> {
  const query = String(rawArgs ?? '')
    .trim()
    .toLowerCase()
  if (name === 'model') {
    const config = await deps.getModelConfig()
    return config.models
      .filter((item) =>
        [item.entryId, item.modelId, item.effectiveDisplayName]
          .join(' ')
          .toLowerCase()
          .includes(query),
      )
      .map((item) => ({
        value: item.entryId,
        label: item.effectiveDisplayName,
        description: `${item.provider} · ${item.modelId}`,
        kind: 'model',
      }))
  }
  if (name === 'effort') {
    const config = await deps.getModelConfig()
    return (config.current?.reasoningEfforts ?? [])
      .filter((value) => value.toLowerCase().includes(query))
      .map((value) => ({ value, label: value, kind: 'reasoning_effort' }))
  }
  if (name === 'resume') {
    return deps
      .listSessions()
      .filter((item) =>
        [item.id, item.title, item.preview]
          .join(' ')
          .toLowerCase()
          .includes(query),
      )
      .slice(0, 20)
      .map((item) => ({
        value: item.id,
        label: item.title,
        description: item.preview,
        kind: 'session',
      }))
  }
  if (name === 'skills') {
    return deps
      .listSkills()
      .filter((item) => item.status === 'active' && item.name.includes(query))
      .map((item) => ({
        value: item.name,
        label: item.name,
        description: item.description,
        kind: 'skill',
      }))
  }
  if (name === 'tools') {
    return deps
      .listTools()
      .filter((item) =>
        `${item.name} ${item.description}`.toLowerCase().includes(query),
      )
      .slice(0, 30)
      .map((item) => ({
        value: item.name,
        label: item.name,
        description: item.description,
        kind: item.source === 'mcp' ? 'mcp_tool' : 'tool',
      }))
  }
  if (name === 'files' || name === 'diff') {
    if (!query) return []
    try {
      const result = await deps.searchWorkspace({
        sessionId,
        query,
        limit: 20,
      })
      return result.entries.map((entry) => ({
        value: entry.path,
        label: entry.name,
        description: entry.path,
        kind: entry.kind,
      }))
    } catch {
      return []
    }
  }
  return []
}
