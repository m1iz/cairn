import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConfigCandidate } from '../config/resolver'
import {
  resolveHybridMemoryMode,
  type HybridMemoryMode,
} from './hybrid-capability'
import type { HybridMemoryDocument } from './hybrid-index'
import type { MemoryEmbeddingProvider } from './hybrid-retrieval'
import {
  applyHybridMemoryPromptProjection,
  HybridMemoryService,
} from './hybrid-service'
import { ContextBuilder } from '../agent/context-builder'

describe('HybridMemoryService', () => {
  it('creates no derivative and performs no search while off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-hybrid-off-'))
    const service = serviceFor(root, 'off')

    const result = await service.retrieve({
      query: 'database endpoint',
      documents: [document('db', '## DB\n\nEndpoint db.internal:6543')],
      scope: { mode: 'chat', sessionId: 's1' },
    })

    expect(result).toMatchObject({
      capability: {
        effectiveMode: 'off',
        promptMutationAllowed: false,
      },
      search: null,
      promptProjection: null,
    })
    expect(existsSync(service.index.indexPath)).toBe(false)
  })

  it('runs a shadow FTS evaluation but cannot mutate prompt in eval mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-hybrid-eval-'))
    const service = serviceFor(root, 'eval')

    const result = await service.retrieve({
      query: 'database endpoint',
      documents: [
        document('db', '## DB\n\nDatabase endpoint db.internal:6543'),
      ],
      scope: { mode: 'chat', sessionId: 's1' },
    })

    expect(result.search?.results[0]?.text).toContain('db.internal:6543')
    expect(result.search?.strategy).toBe('fts')
    expect(result.promptProjection).toBeNull()
    expect(existsSync(service.index.indexPath)).toBe(true)
    expect(service.diagnostics()).toMatchObject({
      searches: 1,
      promptMutations: 0,
      lastStrategy: 'fts',
    })
  })

  it('renders bounded source-attributed memory only after gate and provider capability pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-hybrid-on-'))
    const provider: MemoryEmbeddingProvider = {
      id: 'evaluated-local-provider',
      dimensions: 2,
      async embed(texts) {
        return texts.map(() => [1, 0])
      },
    }
    const service = serviceFor(root, 'on', provider, true)

    const result = await service.retrieve({
      query: 'primary database',
      documents: [
        document('alpha', '## DB\n\nEndpoint db.alpha.internal:6543', {
          source: 'project',
          projectId: 'alpha',
        }),
        document('beta', '## DB\n\nEndpoint db.beta.internal:5432', {
          source: 'project',
          projectId: 'beta',
        }),
      ],
      scope: { mode: 'build', projectId: 'alpha', sessionId: 's1' },
    })

    expect(result.capability).toMatchObject({
      effectiveMode: 'on',
      promptMutationAllowed: true,
    })
    expect(result.search?.results).toHaveLength(1)
    expect(result.promptProjection).toContain('# Retrieved Project Memory')
    expect(result.promptProjection).toContain('db.alpha.internal:6543')
    expect(result.promptProjection).toContain('source=project')
    expect(result.promptProjection).not.toContain('db.beta.internal:5432')
    expect(
      Buffer.byteLength(result.promptProjection ?? ''),
    ).toBeLessThanOrEqual(12_000)

    const baseline = new ContextBuilder(
      join(process.cwd(), '..', '..', 'templates'),
      {
        getAlwaysSkills: () => [],
        loadSkillsForContext: () => '',
        buildSkillsSummary: () => '',
      },
      {
        memory: {
          readMemory: () => 'legacy whole-memory projection',
          memoryFile: 'memory/MEMORY.local.md',
        },
      },
    )
    baseline.setSessionScope({
      mode: 'build',
      projectId: 'alpha',
      projectPath: '/workspace/alpha',
      projectAgents: 'legacy project memory',
      projectAgentsSource: 'projects/alpha/AGENTS.local.md',
    })
    const projected = applyHybridMemoryPromptProjection(
      baseline.buildProjection(),
      result,
    )
    const memorySection = projected.sections.find(
      (section) => section.name === 'project_agents',
    )

    expect(memorySection).toMatchObject({
      stability: 'dynamic',
      source: `hybrid-memory:index:${result.sourceDigest}`,
    })
    expect(projected.prompt).toContain('db.alpha.internal:6543')
    expect(projected.prompt).not.toContain('legacy project memory')
    expect(
      projected.contextPlan.items.find(
        (item) => item.id === 'section:project_agents',
      ),
    ).toMatchObject({ reason: 'hybrid_memory_gate_passed' })
  })

  it('retries a recovered embedding provider after a bounded circuit-breaker delay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-hybrid-retry-'))
    let now = Date.UTC(2026, 6, 19)
    let available = false
    let calls = 0
    const provider: MemoryEmbeddingProvider = {
      id: 'recovering-provider',
      dimensions: 2,
      async embed(texts) {
        calls += 1
        if (!available) throw new Error('temporarily unavailable')
        return texts.map(() => [1, 0])
      },
    }
    const service = new HybridMemoryService({
      stateRoot: root,
      requested: resolveHybridMemoryMode([candidate('eval')]),
      embeddingProvider: provider,
      evaluationGate: null,
      now: () => now,
    })
    const input = {
      query: 'database endpoint',
      documents: [document('db', '## DB\n\nDatabase endpoint db.internal')],
      scope: { mode: 'chat' as const, sessionId: 's1' },
    }

    expect((await service.retrieve(input)).search?.strategy).toBe(
      'fts_fallback',
    )
    available = true
    await service.retrieve(input)
    expect(calls).toBe(1)
    now += 60_000
    expect((await service.retrieve(input)).search?.strategy).toBe('hybrid')
    expect(calls).toBe(3)
  })

  it('allows a managed memory mutation to invalidate the indexed source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-hybrid-invalidate-'))
    const service = serviceFor(root, 'eval')
    const first = await service.retrieve({
      query: 'old preference',
      documents: [document('memory', '## Key Facts\n\n- old preference')],
      scope: { mode: 'chat', sessionId: 's1' },
    })

    service.invalidateSource()
    const second = await service.retrieve({
      query: 'new preference',
      documents: [document('memory', '## Key Facts\n\n- new preference')],
      scope: { mode: 'chat', sessionId: 's1' },
    })

    expect(first.sourceDigest).not.toBe(second.sourceDigest)
    expect(second.search?.results[0]?.text).toContain('new preference')
    expect(second.search?.results[0]?.text).not.toContain('old preference')
  })

  it('serializes per-session source replacement so concurrent searches observe their own snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-hybrid-session-queue-'))
    const service = serviceFor(root, 'eval')

    const [alpha, beta] = await Promise.all([
      service.retrieve({
        query: 'alpha marker',
        documents: [
          document('alpha-session', '## Turn\n\nalpha marker', {
            source: 'session',
            sessionId: 'alpha',
          }),
        ],
        scope: { mode: 'chat', sessionId: 'alpha' },
      }),
      service.retrieve({
        query: 'beta marker',
        documents: [
          document('beta-session', '## Turn\n\nbeta marker', {
            source: 'session',
            sessionId: 'beta',
          }),
        ],
        scope: { mode: 'chat', sessionId: 'beta' },
      }),
    ])

    expect(alpha.search?.results[0]?.text).toContain('alpha marker')
    expect(beta.search?.results[0]?.text).toContain('beta marker')
  })
})

function serviceFor(
  root: string,
  mode: HybridMemoryMode,
  embeddingProvider: MemoryEmbeddingProvider | null = null,
  gatePassed = false,
): HybridMemoryService {
  return new HybridMemoryService({
    stateRoot: root,
    requested: resolveHybridMemoryMode([candidate(mode)]),
    embeddingProvider,
    evaluationGate: {
      passed: gatePassed,
      datasetSha256: 'a'.repeat(64),
      embeddingProviderId: embeddingProvider?.id ?? 'unavailable',
    },
  })
}

function candidate(
  mode: HybridMemoryMode,
): ConfigCandidate<{ mode: HybridMemoryMode }> {
  return {
    source: { kind: 'user', id: 'cairn.local.json', trust: 'trusted' },
    value: { mode },
  }
}

function document(
  id: string,
  content: string,
  overrides: Partial<HybridMemoryDocument> = {},
): HybridMemoryDocument {
  return {
    id,
    content,
    source: 'global',
    path: `${id}.md`,
    createdAt: Date.UTC(2026, 6, 19),
    ...overrides,
  }
}
