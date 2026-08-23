import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalJson } from './events'
import { GoalGateMutationLedger } from './mutation-ledger'
import type { GoalRecord } from './models'
import type { GoalBlockerCause, GoalBlockerCauseReceipt } from './blocker-facts'
import { syncDirectoryBestEffortSync } from '../util/fs-durability'

interface GoalBlockerCauseDocument {
  readonly schemaVersion: 'cairn.goal.blocker-causes.v1'
  readonly receipts: Readonly<Record<string, GoalBlockerCauseReceipt>>
}

type CausePersister = (
  goal: GoalRecord,
  cause: GoalBlockerCause,
  receiptId: string,
) => GoalBlockerCauseReceipt

const PERSISTERS = new WeakMap<GoalBlockerCauseLedger, CausePersister>()
const AUTHORIZED_WRITERS = new WeakMap<object, GoalBlockerCauseLedger>()

/** Read-only public surface; write authority exists only in internal Core wiring. */
export class GoalBlockerCauseLedger {
  readonly path: string
  private readonly mutations: GoalGateMutationLedger

  constructor(readonly stateRoot: string) {
    this.path = join(stateRoot, 'goals', 'blocker-causes.json')
    this.mutations = new GoalGateMutationLedger(stateRoot)
    PERSISTERS.set(this, (goal, cause, receiptId) =>
      this.persist(goal, cause, receiptId),
    )
  }

  inspect(goal: GoalRecord): GoalBlockerCauseReceipt | null {
    try {
      const receipt = this.read().receipts[goal.id]
      if (!receipt) return null
      const parsed = parseReceipt(receipt)
      return parsed.goalId === goal.id &&
        parsed.goalEventSeq === goal.lastEventSeq
        ? parsed
        : null
    } catch {
      return null
    }
  }

  private persist(
    goal: GoalRecord,
    cause: GoalBlockerCause,
    receiptIdValue: string,
  ): GoalBlockerCauseReceipt {
    const receiptId = requiredText(receiptIdValue)
    const base = {
      kind: 'core_goal_blocker_cause' as const,
      issuedBy: 'core' as const,
      goalId: requiredText(goal.id),
      goalEventSeq: requiredEventSeq(goal.lastEventSeq),
      cause: validCause(cause),
      blocking: cause !== 'verification_failure',
      receiptId,
    }
    const version = `cause:${sha256(canonicalJson(base))}`
    const withVersion = { ...base, version }
    const receipt = Object.freeze({
      ...withVersion,
      integritySha256: sha256(canonicalJson(withVersion)),
    })
    return this.mutations.withSynchronousMutation(
      'blocker',
      `${goal.id}:${version}`,
      () => {
        const current = this.read()
        this.write({
          schemaVersion: 'cairn.goal.blocker-causes.v1',
          receipts: { ...current.receipts, [goal.id]: receipt },
        })
        return receipt
      },
    )
  }

  private read(): GoalBlockerCauseDocument {
    if (!existsSync(this.path))
      return { schemaVersion: 'cairn.goal.blocker-causes.v1', receipts: {} }
    const raw = JSON.parse(readFileSync(this.path, 'utf8') || '{}')
    if (
      !isRecord(raw) ||
      raw.schemaVersion !== 'cairn.goal.blocker-causes.v1' ||
      !isRecord(raw.receipts)
    )
      throw new Error('invalid Goal blocker cause ledger')
    return {
      schemaVersion: 'cairn.goal.blocker-causes.v1',
      receipts: raw.receipts as Record<string, GoalBlockerCauseReceipt>,
    }
  }

  private write(document: GoalBlockerCauseDocument): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(document, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
    syncFile(temporary)
    renameSync(temporary, this.path)
    syncDirectoryBestEffortSync(dirname(this.path))
  }
}

export function authorizeGoalBlockerCauseWriter(
  writer: object,
  ledger: GoalBlockerCauseLedger,
): void {
  if (!PERSISTERS.has(ledger))
    throw new Error('Goal blocker cause persister is unavailable.')
  AUTHORIZED_WRITERS.set(writer, ledger)
}

export function persistAuthorizedGoalBlockerCause(
  writer: object,
  ledger: GoalBlockerCauseLedger,
  goal: GoalRecord,
  cause: GoalBlockerCause,
  receiptId: string,
): GoalBlockerCauseReceipt {
  if (AUTHORIZED_WRITERS.get(writer) !== ledger)
    throw new Error('Goal blocker cause writer lacks Core authority.')
  const persist = PERSISTERS.get(ledger)
  if (!persist) throw new Error('Goal blocker cause persister is unavailable.')
  return persist(goal, cause, receiptId)
}

function parseReceipt(value: unknown): GoalBlockerCauseReceipt {
  if (!isRecord(value)) throw new Error('invalid Goal blocker cause receipt')
  const base = {
    kind:
      value.kind === 'core_goal_blocker_cause'
        ? ('core_goal_blocker_cause' as const)
        : fail(),
    issuedBy: value.issuedBy === 'core' ? ('core' as const) : fail(),
    goalId: requiredText(value.goalId),
    goalEventSeq: requiredEventSeq(value.goalEventSeq),
    cause: validCause(value.cause),
    blocking: Boolean(value.blocking),
    receiptId: requiredText(value.receiptId),
  }
  if (base.blocking !== (base.cause !== 'verification_failure')) fail()
  const version = requiredText(value.version)
  if (version !== `cause:${sha256(canonicalJson(base))}`) fail()
  const withVersion = { ...base, version }
  const integritySha256 = requiredSha256(value.integritySha256)
  if (integritySha256 !== sha256(canonicalJson(withVersion))) fail()
  return Object.freeze({ ...withVersion, integritySha256 })
}

function validCause(value: unknown): GoalBlockerCause {
  if (
    value === 'external_dependency' ||
    value === 'missing_permission' ||
    value === 'missing_access' ||
    value === 'unrecoverable_ambiguity' ||
    value === 'safety_policy' ||
    value === 'verification_failure'
  )
    return value
  return fail()
}

function requiredText(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) throw new Error('invalid Goal blocker cause receipt')
  return text
}

function requiredEventSeq(value: unknown): number {
  const sequence = Number(value)
  if (!Number.isInteger(sequence) || sequence < 1) return fail()
  return sequence
}

function requiredSha256(value: unknown): string {
  const text = String(value ?? '')
  if (!/^[a-f0-9]{64}$/.test(text)) return fail()
  return text
}

function syncFile(path: string): void {
  const handle = openSync(path, 'r')
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function fail(): never {
  throw new Error('invalid Goal blocker cause receipt')
}
