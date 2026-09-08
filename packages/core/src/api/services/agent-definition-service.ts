import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  validateAgentDefinition,
  validateAgentDefinitionBundle,
  type AgentDefinition,
  type ExtensionSnapshot,
} from '../../extensions/resolver'
import { writeJsonAtomic } from '../../store/atomic-json'
import { syncFileBestEffort } from '../../util/fs-durability'

export interface UserAgentDefinitionInput {
  name: string
  description: string
  systemPrompt: string
  baseAgent: string
}

export interface UserAgentDefinitionSummary {
  name: string
  description: string
  systemPrompt: string
  baseAgent: string | null
  maxTurns: number
  tools: string[]
}

export interface AgentDefinitionManagementPayload {
  userAgents: UserAgentDefinitionSummary[]
  availableBaseAgents: Array<{ name: string; description: string }>
  restartRequired: boolean
}

export class CoreAgentDefinitionService {
  private readonly root: string
  private readonly snapshot: () => ExtensionSnapshot
  private readonly assertMutation: (area: string, action: string) => void
  private writes: Promise<void> = Promise.resolve()

  constructor(
    stateRoot: string,
    deps: {
      snapshot: () => ExtensionSnapshot
      assertMutation?: (area: string, action: string) => void
    },
  ) {
    this.root = join(stateRoot, 'agents')
    this.snapshot = deps.snapshot
    this.assertMutation = deps.assertMutation ?? (() => {})
  }

  async get(): Promise<AgentDefinitionManagementPayload> {
    const definitions = await this.readBundle()
    const prompts = await Promise.all(
      definitions.map(async (definition) => ({
        name: definition.name,
        description: definition.description,
        systemPrompt: await readFile(
          this.promptPath(definition.prompt),
          'utf8',
        ),
        baseAgent:
          typeof (definition as AgentDefinition & { x_cairn_base?: unknown })
            .x_cairn_base === 'string'
            ? String(
                (definition as AgentDefinition & { x_cairn_base?: unknown })
                  .x_cairn_base,
              )
            : null,
        maxTurns: definition.completion.maxTurns,
        tools: [...definition.tools.allow],
      })),
    )
    return {
      userAgents: prompts,
      availableBaseAgents: this.snapshot()
        .agents.filter((agent) => agent.source.kind !== 'user')
        .map((agent) => ({
          name: agent.definition.name,
          description: agent.definition.description,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      restartRequired: false,
    }
  }

  async save(
    input: UserAgentDefinitionInput,
  ): Promise<AgentDefinitionManagementPayload> {
    this.assertMutation('agentDefinitions', 'save user agent definition')
    const name = String(input.name ?? '').trim()
    const description = String(input.description ?? '').trim()
    const systemPrompt = String(input.systemPrompt ?? '').trim()
    const baseAgent = String(input.baseAgent ?? '').trim()
    if (!systemPrompt) throw new Error('system prompt is required')
    if (Buffer.byteLength(systemPrompt, 'utf8') > 256 * 1024)
      throw new Error('system prompt exceeds 256 KiB')
    const snapshot = this.snapshot()
    const base = snapshot.agents.find(
      (agent) => agent.definition.name === baseAgent,
    )
    if (!base) throw new Error(`unknown base agent: ${baseAgent}`)
    const existingResolved = snapshot.agents.find(
      (agent) => agent.definition.name === name,
    )
    if (existingResolved && existingResolved.source.kind !== 'user')
      throw new Error(`cannot override built-in agent: ${name}`)
    const prompt = `${name}.md`
    const definition = validateAgentDefinition({
      ...structuredClone(base.definition),
      name,
      aliases: [],
      description,
      prompt,
    })
    await this.serial(async () => {
      const agents = await this.readBundle()
      const next = agents.filter((item) => item.name !== name)
      next.push(definition)
      next.sort((a, b) => a.name.localeCompare(b.name))
      await writeTextAtomic(join(this.root, prompt), `${systemPrompt}\n`, 0o600)
      await writeJsonAtomic(
        this.manifestPath(),
        { schemaVersion: 1, agents: next },
        { mode: 0o600 },
      )
    })
    const payload = await this.get()
    return { ...payload, restartRequired: true }
  }

  async delete(name: string): Promise<AgentDefinitionManagementPayload> {
    this.assertMutation('agentDefinitions', 'delete user agent definition')
    const safeName = String(name ?? '').trim()
    await this.serial(async () => {
      const agents = await this.readBundle()
      const target = agents.find((item) => item.name === safeName)
      if (!target) throw new Error(`unknown user agent: ${safeName}`)
      await writeJsonAtomic(
        this.manifestPath(),
        {
          schemaVersion: 1,
          agents: agents.filter((item) => item.name !== safeName),
        },
        { mode: 0o600 },
      )
      await unlink(join(this.root, basename(target.prompt))).catch(() => {})
    })
    const payload = await this.get()
    return { ...payload, restartRequired: true }
  }

  private manifestPath(): string {
    return join(this.root, 'agents.json')
  }

  private promptPath(prompt: string): string {
    if (basename(prompt) !== prompt || !prompt.endsWith('.md'))
      throw new Error(`unsafe user agent prompt path: ${prompt}`)
    return join(this.root, prompt)
  }

  private async readBundle(): Promise<AgentDefinition[]> {
    if (!existsSync(this.manifestPath())) return []
    const parsed = JSON.parse(
      await readFile(this.manifestPath(), 'utf8'),
    ) as unknown
    return validateAgentDefinitionBundle(parsed).agents
  }

  private async serial(action: () => Promise<void>): Promise<void> {
    const next = this.writes.then(action, action)
    this.writes = next.catch(() => {})
    await next
  }
}

async function writeTextAtomic(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporary, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.chmod(mode)
    await syncFileBestEffort(handle)
    await handle.close()
    handle = null
    await rename(temporary, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
}
