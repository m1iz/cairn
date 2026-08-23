import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type Dict = Record<string, unknown>
type TrustStatus = {
  canonicalRoot: string
  digest: string
  status: 'trusted' | 'untrusted' | 'stale'
}
type Source = {
  id: string
  kind: string
  rank: number
  active: boolean
  blockedReason: string | null
}
type ResolvedGroup = { eventName: string; group: Dict; source: Source }
type Snapshot = {
  revision: string
  config: Dict
  groups: ResolvedGroup[]
  sources: Source[]
  diagnostics: Array<{ code: string; path: string; message: string }>
  projectTrust: TrustStatus | null
}

interface TrustStore {
  status(projectRoot: string): Promise<TrustStatus>
  set(opts: {
    projectRoot: string
    expectedDigest: string
    trusted: boolean
  }): Promise<TrustStatus>
}

interface SessionRegistry {
  register(
    sessionId: string,
    config: unknown,
    opts?: { sourceId?: string },
  ): void
  clear(sessionId: string): void
}

interface Resolver {
  resolve(opts?: {
    projectRoot?: string | null
    sessionId?: string | null
  }): Promise<Snapshot>
}

interface SnapshotStore {
  get(opts?: {
    projectRoot?: string | null
    sessionId?: string | null
  }): Promise<Snapshot>
}

async function configApi(): Promise<{
  trust(stateRoot: string): TrustStore
  sessions(): SessionRegistry
  resolver(stateRoot: string, sessions?: SessionRegistry): Resolver
  snapshots(
    resolver: Resolver,
    reviewCandidate?: (
      previous: Snapshot | null,
      candidate: Snapshot,
    ) => boolean | Promise<boolean>,
  ): SnapshotStore
}> {
  const module = (await import('./config')) as unknown as Record<
    string,
    new (...args: unknown[]) => unknown
  >
  expect(module.ProjectHookTrustStore).toBeTypeOf('function')
  expect(module.HookSessionRegistry).toBeTypeOf('function')
  expect(module.HookSourceResolver).toBeTypeOf('function')
  expect(module.HookSnapshotStore).toBeTypeOf('function')
  const ProjectHookTrustStore = module.ProjectHookTrustStore!
  const HookSessionRegistry = module.HookSessionRegistry!
  const HookSourceResolver = module.HookSourceResolver!
  const HookSnapshotStore = module.HookSnapshotStore!
  return {
    trust: (stateRoot) =>
      new ProjectHookTrustStore({ stateRoot }) as TrustStore,
    sessions: () => new HookSessionRegistry() as SessionRegistry,
    resolver: (stateRoot, sessions) =>
      new HookSourceResolver({
        stateRoot,
        sessionRegistry: sessions,
      }) as Resolver,
    snapshots: (resolver, reviewCandidate) =>
      new HookSnapshotStore({ resolver, reviewCandidate }) as SnapshotStore,
  }
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function group(
  id: string,
  handlerId: string,
  type: 'command' | 'http' | 'prompt' = 'command',
): Dict {
  const handler =
    type === 'command'
      ? { id: handlerId, type, command: 'true' }
      : type === 'http'
        ? { id: handlerId, type, url: 'https://hooks.example.test/run' }
        : { id: handlerId, type, prompt: 'Check.' }
  return { id, handlers: [handler] }
}

function writeConfig(
  path: string,
  hooks: Dict,
  opts: { projectHooks?: boolean } = {},
): void {
  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      projectHooks: { enabled: Boolean(opts.projectHooks) },
      hooks,
    }),
    'utf8',
  )
}

describe('hooks v2 source resolution and trust', () => {
  it('blocks project sources until their current digest is trusted', async () => {
    const api = await configApi()
    const stateRoot = tmp('hooks-v2-state-')
    const projectRoot = tmp('hooks-v2-project-')
    mkdirSync(join(projectRoot, '.cairn'), { recursive: true })
    writeConfig(
      join(stateRoot, 'hooks_config.json'),
      { Stop: [group('global', 'global-handler')] },
      { projectHooks: true },
    )
    writeConfig(join(projectRoot, '.cairn/settings.json'), {
      Stop: [group('project', 'project-handler')],
    })

    const resolver = api.resolver(stateRoot)
    const untrusted = await resolver.resolve({ projectRoot, sessionId: 's1' })

    expect(untrusted.groups.map((item) => item.group.id)).toEqual(['global'])
    expect(untrusted.projectTrust?.status).toBe('untrusted')
    expect(
      untrusted.sources.find((source) => source.kind === 'project'),
    ).toMatchObject({ active: false, blockedReason: 'project_untrusted' })

    const trust = api.trust(stateRoot)
    const current = await trust.status(projectRoot)
    await trust.set({
      projectRoot,
      expectedDigest: current.digest,
      trusted: true,
    })
    const trusted = await resolver.resolve({ projectRoot, sessionId: 's1' })

    expect(trusted.projectTrust?.status).toBe('trusted')
    expect(trusted.groups.map((item) => item.group.id)).toEqual([
      'global',
      'project',
    ])
  })

  it('uses global < project < project-local < session precedence for equal group ids', async () => {
    const api = await configApi()
    const stateRoot = tmp('hooks-v2-precedence-state-')
    const projectRoot = tmp('hooks-v2-precedence-project-')
    mkdirSync(join(projectRoot, '.cairn'), { recursive: true })
    writeConfig(
      join(stateRoot, 'hooks_config.json'),
      {
        Stop: [
          group('guard', 'global-guard'),
          group('global-only', 'global-only-handler'),
        ],
      },
      { projectHooks: true },
    )
    writeConfig(join(projectRoot, '.cairn/settings.json'), {
      Stop: [
        group('guard', 'project-guard', 'prompt'),
        group('project-only', 'project-only-handler'),
      ],
    })
    writeConfig(join(projectRoot, '.cairn/settings.local.json'), {
      Stop: [
        group('guard', 'local-guard', 'http'),
        group('local-only', 'local-only-handler'),
      ],
    })

    const trust = api.trust(stateRoot)
    const current = await trust.status(projectRoot)
    await trust.set({
      projectRoot,
      expectedDigest: current.digest,
      trusted: true,
    })
    const sessions = api.sessions()
    sessions.register('s1', {
      version: 2,
      hooks: {
        Stop: [
          group('guard', 'session-guard'),
          group('session-only', 'session-only-handler'),
        ],
      },
    })
    const snapshot = await api
      .resolver(stateRoot, sessions)
      .resolve({ projectRoot, sessionId: 's1' })

    expect(
      snapshot.groups.map((item) => [item.group.id, item.source.kind]),
    ).toEqual([
      ['global-only', 'global'],
      ['project-only', 'project'],
      ['local-only', 'project-local'],
      ['guard', 'session'],
      ['session-only', 'session'],
    ])
  })

  it('invalidates project trust when either project hook file changes', async () => {
    const api = await configApi()
    const stateRoot = tmp('hooks-v2-digest-state-')
    const projectRoot = tmp('hooks-v2-digest-project-')
    mkdirSync(join(projectRoot, '.cairn'), { recursive: true })
    writeConfig(
      join(stateRoot, 'hooks_config.json'),
      {},
      { projectHooks: true },
    )
    const shared = join(projectRoot, '.cairn/settings.json')
    writeConfig(shared, { Stop: [group('first', 'first-handler')] })

    const trust = api.trust(stateRoot)
    const before = await trust.status(projectRoot)
    await trust.set({
      projectRoot,
      expectedDigest: before.digest,
      trusted: true,
    })
    writeConfig(shared, { Stop: [group('changed', 'changed-handler')] })
    const after = await trust.status(projectRoot)

    expect(after.status).toBe('stale')
    expect(after.digest).not.toBe(before.digest)
    const snapshot = await api.resolver(stateRoot).resolve({ projectRoot })
    expect(snapshot.groups).toEqual([])
  })

  it('isolates and clears in-memory session sources', async () => {
    const api = await configApi()
    const stateRoot = tmp('hooks-v2-session-state-')
    writeConfig(join(stateRoot, 'hooks_config.json'), {})
    const sessions = api.sessions()
    sessions.register('a', {
      version: 2,
      hooks: { Stop: [group('session-a', 'session-a-handler')] },
    })
    const resolver = api.resolver(stateRoot, sessions)

    expect(
      (await resolver.resolve({ sessionId: 'a' })).groups.map(
        (item) => item.group.id,
      ),
    ).toEqual(['session-a'])
    expect((await resolver.resolve({ sessionId: 'b' })).groups).toEqual([])
    sessions.clear('a')
    expect((await resolver.resolve({ sessionId: 'a' })).groups).toEqual([])
  })

  it('returns immutable snapshots and changes revision only on accepted source changes', async () => {
    const api = await configApi()
    const stateRoot = tmp('hooks-v2-snapshot-state-')
    const configPath = join(stateRoot, 'hooks_config.json')
    writeConfig(configPath, { Stop: [group('first', 'first-handler')] })
    const resolver = api.resolver(stateRoot)
    const first = await resolver.resolve()
    writeConfig(configPath, { Stop: [group('second', 'second-handler')] })
    const second = await resolver.resolve()

    expect(first.groups.map((item) => item.group.id)).toEqual(['first'])
    expect(second.groups.map((item) => item.group.id)).toEqual(['second'])
    expect(second.revision).not.toBe(first.revision)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.groups)).toBe(true)
  })

  it('keeps the previously accepted snapshot when candidate review rejects a change', async () => {
    const api = await configApi()
    const stateRoot = tmp('hooks-v2-review-state-')
    const configPath = join(stateRoot, 'hooks_config.json')
    writeConfig(configPath, { Stop: [group('accepted', 'accepted-handler')] })
    const resolver = api.resolver(stateRoot)
    const snapshots = api.snapshots(resolver, (previous) => previous === null)
    const first = await snapshots.get()
    writeConfig(configPath, { Stop: [group('rejected', 'rejected-handler')] })
    const second = await snapshots.get()

    expect(second.revision).toBe(first.revision)
    expect(second.groups.map((item) => item.group.id)).toEqual(['accepted'])
    expect(second.diagnostics.map((item) => item.code)).toContain(
      'candidate_rejected',
    )
  })

  it('rejects stale trust mutations without changing the stored decision', async () => {
    const api = await configApi()
    const stateRoot = tmp('hooks-v2-trust-race-state-')
    const projectRoot = tmp('hooks-v2-trust-race-project-')
    mkdirSync(join(projectRoot, '.cairn'), { recursive: true })
    const shared = join(projectRoot, '.cairn/settings.json')
    writeConfig(shared, { Stop: [group('first', 'first-handler')] })
    const trust = api.trust(stateRoot)
    const first = await trust.status(projectRoot)
    writeConfig(shared, { Stop: [group('second', 'second-handler')] })

    await expect(
      trust.set({ projectRoot, expectedDigest: first.digest, trusted: true }),
    ).rejects.toThrow(/digest changed/i)
    expect((await trust.status(projectRoot)).status).toBe('untrusted')
  })
})
