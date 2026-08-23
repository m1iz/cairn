import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CairnError } from '../errors'
import { canonicalJson } from './events'
import { GoalMutationGuard, type GoalMutationLease } from './mutation-guard'

export const GOAL_GATE_MUTATION_SCHEMA_VERSION =
  'cairn.goal.gate-mutations.v1' as const

export type GoalGateMutationSource =
  | 'goal'
  | 'plan'
  | 'control'
  | 'task'
  | 'transcript'
  | 'observation'
  | 'scope'
  | 'storage'
  | 'hard_constraints'
  | 'cost'
  | 'runtime'
  | 'cleanup'
  | 'blocker'

export interface GoalGateMutationSnapshot {
  readonly epoch: number
  readonly versions: Readonly<Record<string, string>>
}

interface GoalGateMutationDocument extends GoalGateMutationSnapshot {
  readonly schemaVersion: typeof GOAL_GATE_MUTATION_SCHEMA_VERSION
}

export class GoalGateMutationError extends CairnError {
  constructor(code: string, message: string) {
    super(message, code)
  }
}

export class GoalGateMutationLedger {
  readonly stateRoot: string
  readonly path: string
  readonly guard: GoalMutationGuard

  constructor(stateRoot: string) {
    this.stateRoot = resolve(stateRoot)
    this.path = join(this.stateRoot, 'goals', 'gate-mutations.json')
    this.guard = new GoalMutationGuard(this.stateRoot)
  }

  inspect(): GoalGateMutationSnapshot {
    if (!existsSync(this.path))
      return freezeSnapshot({ epoch: 0, versions: {} })
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      throw new GoalGateMutationError(
        'goal_gate_mutation_ledger_corrupt',
        'Goal gate mutation ledger is corrupt.',
      )
    }
    if (!isDocument(parsed))
      throw new GoalGateMutationError(
        'goal_gate_mutation_ledger_corrupt',
        'Goal gate mutation ledger is invalid.',
      )
    return freezeSnapshot({
      epoch: parsed.epoch,
      versions: sortedVersions(parsed.versions),
    })
  }

  record(
    source: GoalGateMutationSource,
    versionValue: string,
  ): GoalGateMutationSnapshot {
    const version = String(versionValue ?? '').trim()
    if (!version)
      throw new GoalGateMutationError(
        'goal_gate_mutation_version_invalid',
        'Goal gate mutation version is required.',
      )
    return this.guard.runExclusiveSync('mutation', (lease) =>
      this.recordUnderLease(lease, source, version),
    )
  }

  recordUnderLease(
    lease: GoalMutationLease,
    source: GoalGateMutationSource,
    versionValue: string,
  ): GoalGateMutationSnapshot {
    this.guard.assertLease(lease)
    const version = String(versionValue ?? '').trim()
    if (!version)
      throw new GoalGateMutationError(
        'goal_gate_mutation_version_invalid',
        'Goal gate mutation version is required.',
      )
    const current = this.inspect()
    const next = freezeSnapshot({
      epoch: current.epoch + 1,
      versions: sortedVersions({ ...current.versions, [source]: version }),
    })
    this.write(next)
    return next
  }

  async withMutation<T>(
    source: GoalGateMutationSource,
    version: string,
    action: (lease: GoalMutationLease) => T | Promise<T>,
  ): Promise<T> {
    return await this.guard.runExclusive('mutation', async (lease) => {
      this.recordUnderLease(lease, source, version)
      return await action(lease)
    })
  }

  withSynchronousMutation<T>(
    source: GoalGateMutationSource,
    version: string,
    action: (lease: GoalMutationLease) => T,
  ): T {
    return this.guard.runExclusiveSync('mutation', (lease) => {
      this.recordUnderLease(lease, source, version)
      return action(lease)
    })
  }

  async withTerminalPrecondition<T>(
    expected: GoalGateMutationSnapshot,
    validate: (lease: GoalMutationLease) => T | Promise<T>,
  ): Promise<T> {
    return await this.guard.runExclusive('terminal', async (lease) => {
      assertSameSnapshot(this.inspect(), expected)
      return await validate(lease)
    })
  }

  assertPreconditionUnderLease(
    lease: GoalMutationLease,
    expected: GoalGateMutationSnapshot,
  ): void {
    this.guard.assertLease(lease, 'terminal')
    assertSameSnapshot(this.inspect(), expected)
  }

  private write(snapshot: GoalGateMutationSnapshot): void {
    const document: GoalGateMutationDocument = {
      schemaVersion: GOAL_GATE_MUTATION_SCHEMA_VERSION,
      epoch: snapshot.epoch,
      versions: sortedVersions(snapshot.versions),
    }
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    const temporary = join(
      directory,
      `.gate-mutations.${randomUUID().replace(/-/g, '')}.tmp`,
    )
    writeFileSync(temporary, JSON.stringify(document, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
  }
}

function assertSameSnapshot(
  current: GoalGateMutationSnapshot,
  expected: GoalGateMutationSnapshot,
): void {
  if (canonicalJson(current) !== canonicalJson(expected))
    throw new GoalGateMutationError(
      'goal_terminal_precondition_conflict',
      'Gate-sensitive facts changed before terminal commit.',
    )
}

function isDocument(value: unknown): value is GoalGateMutationDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (
    item.schemaVersion !== GOAL_GATE_MUTATION_SCHEMA_VERSION ||
    !Number.isSafeInteger(item.epoch) ||
    Number(item.epoch) < 0 ||
    !item.versions ||
    typeof item.versions !== 'object' ||
    Array.isArray(item.versions)
  )
    return false
  return Object.entries(item.versions as Record<string, unknown>).every(
    ([key, child]) =>
      Boolean(key.trim()) && typeof child === 'string' && child.trim(),
  )
}

function sortedVersions(
  value: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, child]) => [key, String(child)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function freezeSnapshot(
  value: GoalGateMutationSnapshot,
): GoalGateMutationSnapshot {
  return Object.freeze({
    epoch: value.epoch,
    versions: Object.freeze({ ...value.versions }),
  })
}
