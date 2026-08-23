import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CairnError } from '../errors'
import { canonicalJson } from './events'
import {
  GoalGateMutationLedger,
  type GoalGateMutationSource,
} from './mutation-ledger'
import type { GoalMutationLease } from './mutation-guard'
import type { GoalRecord } from './models'
import {
  syncDirectoryBestEffortSync,
  syncFileBestEffortSync,
} from '../util/fs-durability'

export const GOAL_GATE_FACT_SCHEMA_VERSION = 'cairn.goal.gate-fact.v1' as const
const DOCUMENT_SCHEMA_VERSION = 'cairn.goal.gate-facts.v1' as const

export type GoalGateFactDomain =
  'runtime' | 'scope' | 'storage' | 'hard_constraints' | 'cost'

export interface GoalRuntimeGateFactValue {
  readonly pendingInteractionId: string | null
  readonly directlyAnswerable: boolean
}

export interface GoalScopeGateFactValue {
  readonly matches: boolean
}

export interface GoalStorageGateFactValue {
  readonly healthy: boolean
}

export interface GoalHardConstraintsGateFactValue {
  readonly satisfied: boolean
}

export interface GoalCostGateFactValue {
  readonly estimatedCostUsd: number | null
}

export interface GoalGateFactValueByDomain {
  readonly runtime: GoalRuntimeGateFactValue
  readonly scope: GoalScopeGateFactValue
  readonly storage: GoalStorageGateFactValue
  readonly hard_constraints: GoalHardConstraintsGateFactValue
  readonly cost: GoalCostGateFactValue
}

export interface GoalGateFactRecord<D extends GoalGateFactDomain> {
  readonly schemaVersion: typeof GOAL_GATE_FACT_SCHEMA_VERSION
  readonly id: string
  readonly goalId: string
  readonly goalEventSeq: number
  readonly domain: D
  readonly value: GoalGateFactValueByDomain[D]
  readonly version: string
  readonly recordedAt: string
  readonly integritySha256: string
}

export interface GoalGateFactBundle {
  readonly runtime: GoalGateFactRecord<'runtime'> | null
  readonly scope: GoalGateFactRecord<'scope'> | null
  readonly storage: GoalGateFactRecord<'storage'> | null
  readonly hardConstraints: GoalGateFactRecord<'hard_constraints'> | null
  readonly cost: GoalGateFactRecord<'cost'> | null
}

export interface GoalGateFactBundleInput {
  readonly runtime?: GoalRuntimeGateFactValue
  readonly scope?: GoalScopeGateFactValue
  readonly storage?: GoalStorageGateFactValue
  readonly hardConstraints?: GoalHardConstraintsGateFactValue
  readonly cost?: GoalCostGateFactValue
}

/** Builds deterministic in-memory facts for a pure live-source Gate read. */
export function createGoalGateFactBundle(
  goal: Pick<GoalRecord, 'id' | 'lastEventSeq' | 'updatedAt'>,
  input: GoalGateFactBundleInput,
): GoalGateFactBundle {
  const identity = validateGoalIdentity(goal)
  validateInput(input)
  const byDomain = new Map(
    inputEntries(input).map(([domain, value]) => [
      domain,
      makeRecord(
        identity.id,
        identity.lastEventSeq,
        domain,
        value,
        goal.updatedAt,
      ),
    ]),
  )
  return Object.freeze({
    runtime:
      (byDomain.get('runtime') as GoalGateFactRecord<'runtime'> | undefined) ??
      null,
    scope:
      (byDomain.get('scope') as GoalGateFactRecord<'scope'> | undefined) ??
      null,
    storage:
      (byDomain.get('storage') as GoalGateFactRecord<'storage'> | undefined) ??
      null,
    hardConstraints:
      (byDomain.get('hard_constraints') as
        GoalGateFactRecord<'hard_constraints'> | undefined) ?? null,
    cost:
      (byDomain.get('cost') as GoalGateFactRecord<'cost'> | undefined) ?? null,
  })
}

interface GoalGateFactDocument {
  readonly schemaVersion: typeof DOCUMENT_SCHEMA_VERSION
  readonly facts: Readonly<Record<string, unknown>>
}

export class GoalGateFactStoreError extends CairnError {
  constructor(code: string, message: string) {
    super(message, code)
  }
}

export class GoalGateFactStore {
  readonly stateRoot: string
  readonly path: string
  private readonly mutations: GoalGateMutationLedger
  private readonly now: () => string

  constructor(
    stateRoot: string,
    options: { readonly now?: () => string } = {},
  ) {
    this.stateRoot = resolve(stateRoot)
    this.path = join(this.stateRoot, 'goals', 'gate-facts.json')
    this.mutations = new GoalGateMutationLedger(this.stateRoot)
    this.now = options.now ?? (() => new Date().toISOString())
  }

  recordBundle(
    goal: Pick<GoalRecord, 'id' | 'lastEventSeq'>,
    input: GoalGateFactBundleInput,
  ): GoalGateFactBundle {
    return this.mutations.guard.runExclusiveSync('mutation', (lease) =>
      this.recordBundleUnderLease(lease, goal, input),
    )
  }

  /** Publishes facts while a caller owns the shared Goal mutation lease. */
  recordBundleUnderLease(
    lease: GoalMutationLease,
    goal: Pick<GoalRecord, 'id' | 'lastEventSeq'>,
    input: GoalGateFactBundleInput,
  ): GoalGateFactBundle {
    this.mutations.guard.assertLease(lease)
    const identity = validateGoalIdentity(goal)
    validateInput(input)
    const entries = inputEntries(input)
    if (entries.length === 0) return this.inspectBundle(goal)
    const document = this.readDocument(true)
    const facts = { ...document.facts }
    for (const [domain, value] of entries) {
      const record = makeRecord(
        identity.id,
        identity.lastEventSeq,
        domain,
        value,
        this.now(),
      )
      this.mutations.recordUnderLease(
        lease,
        mutationSource(domain),
        record.version,
      )
      facts[factKey(identity.id, domain)] = record
    }
    this.writeDocument({ schemaVersion: DOCUMENT_SCHEMA_VERSION, facts })
    return this.inspectBundle(goal)
  }

  inspectBundle(
    goal: Pick<GoalRecord, 'id' | 'lastEventSeq'>,
  ): GoalGateFactBundle {
    const identity = validateGoalIdentity(goal)
    const document = this.readDocument(false)
    return Object.freeze({
      runtime: this.readFact(document, identity, 'runtime'),
      scope: this.readFact(document, identity, 'scope'),
      storage: this.readFact(document, identity, 'storage'),
      hardConstraints: this.readFact(document, identity, 'hard_constraints'),
      cost: this.readFact(document, identity, 'cost'),
    })
  }

  private readFact<D extends GoalGateFactDomain>(
    document: GoalGateFactDocument,
    goal: { readonly id: string; readonly lastEventSeq: number },
    domain: D,
  ): GoalGateFactRecord<D> | null {
    const raw = document.facts[factKey(goal.id, domain)]
    const record = parseRecord(raw, domain)
    if (
      !record ||
      record.goalId !== goal.id ||
      record.goalEventSeq !== goal.lastEventSeq
    )
      return null
    return record
  }

  private readDocument(failOnCorrupt: boolean): GoalGateFactDocument {
    if (!existsSync(this.path))
      return { schemaVersion: DOCUMENT_SCHEMA_VERSION, facts: {} }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (!isRecord(raw) || raw.schemaVersion !== DOCUMENT_SCHEMA_VERSION)
        throw new Error('invalid fact document')
      if (!isRecord(raw.facts)) throw new Error('invalid fact map')
      return {
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
        facts: raw.facts,
      }
    } catch {
      if (failOnCorrupt)
        throw new GoalGateFactStoreError(
          'goal_gate_fact_store_corrupt',
          'Goal gate fact store is corrupt.',
        )
      return { schemaVersion: DOCUMENT_SCHEMA_VERSION, facts: {} }
    }
  }

  private writeDocument(document: GoalGateFactDocument): void {
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    const temporary = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(document), {
      encoding: 'utf8',
      mode: 0o600,
    })
    const file = openSync(temporary, 'r')
    try {
      syncFileBestEffortSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, this.path)
    syncDirectoryBestEffortSync(directory)
  }
}

function makeRecord<D extends GoalGateFactDomain>(
  goalId: string,
  goalEventSeq: number,
  domain: D,
  value: GoalGateFactValueByDomain[D],
  recordedAt: string,
): GoalGateFactRecord<D> {
  const draft = {
    schemaVersion: GOAL_GATE_FACT_SCHEMA_VERSION,
    goalId,
    goalEventSeq,
    domain,
    value,
    recordedAt,
  }
  const versionHash = sha256(canonicalJson(draft))
  const base = {
    ...draft,
    id: `goal_fact_${versionHash.slice(0, 24)}`,
    version: `${domain}:${versionHash}`,
  }
  return Object.freeze({
    ...base,
    integritySha256: sha256(canonicalJson(base)),
  }) as GoalGateFactRecord<D>
}

function parseRecord<D extends GoalGateFactDomain>(
  raw: unknown,
  domain: D,
): GoalGateFactRecord<D> | null {
  if (!isRecord(raw)) return null
  const base = {
    schemaVersion: raw.schemaVersion,
    goalId: raw.goalId,
    goalEventSeq: raw.goalEventSeq,
    domain: raw.domain,
    value: raw.value,
    recordedAt: raw.recordedAt,
    id: raw.id,
    version: raw.version,
  }
  if (
    base.schemaVersion !== GOAL_GATE_FACT_SCHEMA_VERSION ||
    typeof base.goalId !== 'string' ||
    !Number.isInteger(base.goalEventSeq) ||
    base.domain !== domain ||
    typeof base.recordedAt !== 'string' ||
    !Number.isFinite(Date.parse(base.recordedAt)) ||
    typeof base.id !== 'string' ||
    typeof base.version !== 'string' ||
    !validDomainValue(domain, base.value) ||
    typeof raw.integritySha256 !== 'string' ||
    sha256(canonicalJson(base)) !== raw.integritySha256
  )
    return null
  const versionDraft = {
    schemaVersion: base.schemaVersion,
    goalId: base.goalId,
    goalEventSeq: base.goalEventSeq,
    domain: base.domain,
    value: base.value,
    recordedAt: base.recordedAt,
  }
  const hash = sha256(canonicalJson(versionDraft))
  if (
    base.id !== `goal_fact_${hash.slice(0, 24)}` ||
    base.version !== `${domain}:${hash}`
  )
    return null
  return Object.freeze({
    ...base,
    integritySha256: raw.integritySha256,
  }) as GoalGateFactRecord<D>
}

function validateInput(input: GoalGateFactBundleInput): void {
  for (const [domain, value] of inputEntries(input))
    if (!validDomainValue(domain, value))
      throw new GoalGateFactStoreError(
        'goal_gate_fact_invalid',
        `Goal ${domain} fact is invalid.`,
      )
}

function validDomainValue(domain: GoalGateFactDomain, value: unknown): boolean {
  if (!isRecord(value)) return false
  if (domain === 'runtime')
    return (
      (value.pendingInteractionId === null ||
        typeof value.pendingInteractionId === 'string') &&
      typeof value.directlyAnswerable === 'boolean'
    )
  if (domain === 'scope') return typeof value.matches === 'boolean'
  if (domain === 'storage') return typeof value.healthy === 'boolean'
  if (domain === 'hard_constraints') return typeof value.satisfied === 'boolean'
  const cost = value.estimatedCostUsd
  return (
    cost === null ||
    (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
  )
}

function inputEntries(
  input: GoalGateFactBundleInput,
): Array<[GoalGateFactDomain, GoalGateFactValueByDomain[GoalGateFactDomain]]> {
  const entries: Array<
    [GoalGateFactDomain, GoalGateFactValueByDomain[GoalGateFactDomain]]
  > = []
  if (input.runtime !== undefined) entries.push(['runtime', input.runtime])
  if (input.scope !== undefined) entries.push(['scope', input.scope])
  if (input.storage !== undefined) entries.push(['storage', input.storage])
  if (input.hardConstraints !== undefined)
    entries.push(['hard_constraints', input.hardConstraints])
  if (input.cost !== undefined) entries.push(['cost', input.cost])
  return entries
}

function validateGoalIdentity(goal: Pick<GoalRecord, 'id' | 'lastEventSeq'>): {
  readonly id: string
  readonly lastEventSeq: number
} {
  const id = String(goal.id ?? '').trim()
  const lastEventSeq = Number(goal.lastEventSeq)
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ||
    !Number.isInteger(lastEventSeq) ||
    lastEventSeq < 0
  )
    throw new GoalGateFactStoreError(
      'goal_gate_fact_invalid',
      'Goal gate fact identity is invalid.',
    )
  return { id, lastEventSeq }
}

function factKey(goalId: string, domain: GoalGateFactDomain): string {
  return `${goalId}:${domain}`
}

function mutationSource(domain: GoalGateFactDomain): GoalGateMutationSource {
  return domain === 'hard_constraints' ? 'hard_constraints' : domain
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
