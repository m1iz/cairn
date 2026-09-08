import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SubagentRegistry } from '../../subagents/registry'
import { CoreAgentDefinitionService } from './agent-definition-service'

const TEMPLATES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'templates',
  'subagents',
)

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'cairn-agent-definitions-'))
  const registry = new SubagentRegistry(TEMPLATES)
  const mutations: string[] = []
  return {
    stateRoot,
    service: new CoreAgentDefinitionService(stateRoot, {
      snapshot: () => registry.snapshot(),
      assertMutation: (area, action) => mutations.push(`${area}:${action}`),
    }),
    mutations,
  }
}

describe('CoreAgentDefinitionService', () => {
  it('clones a trusted base into an atomically persisted user definition', async () => {
    const test = fixture()
    const saved = await test.service.save({
      name: 'local_reviewer',
      description: 'Review local changes',
      systemPrompt: 'Review the requested change and report evidence.',
      baseAgent: 'inventory_reviewer',
    })

    expect(saved.restartRequired).toBe(true)
    expect(saved.userAgents[0]).toMatchObject({
      name: 'local_reviewer',
      description: 'Review local changes',
    })
    expect(saved.userAgents[0]?.tools.length).toBeGreaterThan(0)
    expect(test.mutations).toEqual([
      'agentDefinitions:save user agent definition',
    ])
    expect(
      JSON.parse(
        readFileSync(join(test.stateRoot, 'agents', 'agents.json'), 'utf8'),
      ).agents[0].prompt,
    ).toBe('local_reviewer.md')
    expect(
      readFileSync(join(test.stateRoot, 'agents', 'local_reviewer.md'), 'utf8'),
    ).toContain('Review the requested change')
  })

  it('refuses builtin overrides and deletes only persisted user agents', async () => {
    const test = fixture()
    await expect(
      test.service.save({
        name: 'code_explorer',
        description: 'unsafe override',
        systemPrompt: 'override',
        baseAgent: 'code_explorer',
      }),
    ).rejects.toThrow('cannot override built-in')

    await test.service.save({
      name: 'local_reader',
      description: 'Local reader',
      systemPrompt: 'Read only.',
      baseAgent: 'code_explorer',
    })
    const deleted = await test.service.delete('local_reader')
    expect(deleted.userAgents).toEqual([])
    expect(existsSync(join(test.stateRoot, 'agents', 'local_reader.md'))).toBe(
      false,
    )
  })
})
