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
import { syncDirectoryBestEffortSync } from '../util/fs-durability'
import { GoalGateMutationLedger } from './mutation-ledger'
import type { GoalRecord } from './models'
import { CairnError } from '../errors'
import { redactSensitiveOutput } from '../util/redaction'

export type GoalTypedBlockerCode =
  | 'external_dependency'
  | 'missing_permission'
  | 'missing_access'
  | 'unrecoverable_ambiguity'
  | 'safety_policy'

export type GoalBlockerCause = GoalTypedBlockerCode | 'verification_failure'

export interface GoalBlockerCauseReceipt {
  readonly kind: 'core_goal_blocker_cause'
  readonly issuedBy: 'core'
  readonly goalId: string
  readonly goalEventSeq: number
  readonly cause: GoalBlockerCause
  readonly blocking: boolean
  readonly receiptId: string
  readonly version: string
  readonly integritySha256: string
}

export class GoalBlockerFactIssuerError extends CairnError {
  constructor(code: string, message: string) {
    super(message, code)
  }
}

export interface GoalBlockerFact {
  readonly schemaVersion: 'cairn.goal.blocker-fact.v1'
  readonly kind: 'core_goal_blocker'
  readonly goalId: string
  readonly goalEventSeq: number
  readonly code: GoalTypedBlockerCode
  readonly blocking: true
  readonly source: 'core'
  readonly reasonSha256: string
  readonly evidenceReceiptId: string
  readonly evidenceVersion: string
  readonly version: string
  readonly createdAt: string
  readonly integritySha256: string
}

interface GoalBlockerFactDocument {
  readonly schemaVersion: 'cairn.goal.blocker-facts.v1'
  readonly facts: Readonly<Record<string, GoalBlockerFact>>
}

type GoalBlockerFactPersister = (
  goal: GoalRecord,
  input: {
    readonly code: GoalTypedBlockerCode
    readonly reasonSha256: string
    readonly evidenceReceiptId: string
    readonly evidenceVersion: string
    readonly createdAt?: string
  },
) => GoalBlockerFact

const FACT_PERSISTERS = new WeakMap<
  GoalBlockerFactStore,
  GoalBlockerFactPersister
>()
const AUTHORIZED_ISSUERS = new WeakMap<object, GoalBlockerFactStore>()

export class GoalBlockerFactStore {
  readonly path: string
  private readonly mutations: GoalGateMutationLedger

  constructor(readonly stateRoot: string) {
    this.path = join(stateRoot, 'goals', 'blocker-facts.json')
    this.mutations = new GoalGateMutationLedger(stateRoot)
    FACT_PERSISTERS.set(this, (goal, input) => this.persist(goal, input))
  }

  private persist(
    goal: GoalRecord,
    input: {
      readonly code: GoalTypedBlockerCode
      readonly reasonSha256: string
      readonly evidenceReceiptId: string
      readonly evidenceVersion: string
      readonly createdAt?: string
    },
  ): GoalBlockerFact {
    const base = {
      schemaVersion: 'cairn.goal.blocker-fact.v1' as const,
      kind: 'core_goal_blocker' as const,
      goalId: requiredText(goal.id),
      goalEventSeq: requiredEventSeq(goal.lastEventSeq),
      code: validCode(input.code),
      blocking: true as const,
      source: 'core' as const,
      reasonSha256: requiredSha256(input.reasonSha256),
      evidenceReceiptId: requiredText(input.evidenceReceiptId),
      evidenceVersion: requiredText(input.evidenceVersion),
      createdAt: requiredTimestamp(input.createdAt ?? new Date().toISOString()),
    }
    const version = `blocker:${sha256(canonicalJson(base))}`
    const withVersion = { ...base, version }
    const fact: GoalBlockerFact = Object.freeze({
      ...withVersion,
      integritySha256: sha256(canonicalJson(withVersion)),
    })
    return this.mutations.withSynchronousMutation(
      'blocker',
      `${goal.id}:${fact.version}`,
      () => {
        const document = this.readDocument()
        this.writeDocument({
          schemaVersion: 'cairn.goal.blocker-facts.v1',
          facts: { ...document.facts, [goal.id]: fact },
        })
        return fact
      },
    )
  }

  inspect(goal: GoalRecord): GoalBlockerFact | null {
    try {
      const fact = this.readDocument().facts[goal.id]
      if (!fact) return null
      const parsed = parseFact(fact)
      return parsed.goalId === goal.id &&
        parsed.goalEventSeq === goal.lastEventSeq
        ? parsed
        : null
    } catch {
      return null
    }
  }

  private readDocument(): GoalBlockerFactDocument {
    if (!existsSync(this.path))
      return { schemaVersion: 'cairn.goal.blocker-facts.v1', facts: {} }
    const raw = JSON.parse(readFileSync(this.path, 'utf8') || '{}')
    if (
      !isRecord(raw) ||
      raw.schemaVersion !== 'cairn.goal.blocker-facts.v1' ||
      !isRecord(raw.facts)
    )
      throw new Error('invalid Goal blocker fact store')
    return {
      schemaVersion: 'cairn.goal.blocker-facts.v1',
      facts: raw.facts as Record<string, GoalBlockerFact>,
    }
  }

  private writeDocument(document: GoalBlockerFactDocument): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(document, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
    const handle = openSync(tmp, 'r')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(tmp, this.path)
    syncDirectoryBestEffortSync(dirname(this.path))
  }
}

/** Internal authority grant; blocker-facts.ts is not re-exported publicly. */
export function authorizeGoalBlockerFactIssuer(
  issuer: object,
  store: GoalBlockerFactStore,
): void {
  if (!FACT_PERSISTERS.has(store))
    throw new Error('Goal blocker fact persister is unavailable.')
  AUTHORIZED_ISSUERS.set(issuer, store)
}

export function persistAuthorizedGoalBlockerFact(
  issuer: object,
  store: GoalBlockerFactStore,
  goal: GoalRecord,
  input: {
    readonly code: GoalTypedBlockerCode
    readonly reason: string
    readonly cause: GoalBlockerCauseReceipt | null
    readonly createdAt: string
  },
): GoalBlockerFact {
  if (AUTHORIZED_ISSUERS.get(issuer) !== store)
    throw new GoalBlockerFactIssuerError(
      'goal_blocker_issuer_unauthorized',
      'Goal blocker fact issuer lacks Core authority.',
    )
  const code = validCode(input.code)
  const reason = normalizeGoalBlockReason(input.reason)
  if (input.cause?.cause === 'verification_failure')
    throw new GoalBlockerFactIssuerError(
      'goal_block_verification_failure',
      'Verification failures are recoverable and cannot issue terminal blocker facts.',
    )
  if (!exactCauseReceipt(input.cause, goal, code))
    throw new GoalBlockerFactIssuerError(
      'goal_blocker_cause_untrusted',
      'Goal blocker issuance requires an exact trusted Core cause receipt.',
    )
  const persist = FACT_PERSISTERS.get(store)
  if (!persist) throw new Error('Goal blocker fact persister is unavailable.')
  return persist(goal, {
    code,
    reasonSha256: goalBlockReasonSha256(reason),
    evidenceReceiptId: input.cause.receiptId,
    evidenceVersion: input.cause.version,
    createdAt: input.createdAt,
  })
}

export function goalBlockReasonSha256(reason: string): string {
  return sha256(String(reason ?? ''))
}

export function normalizeGoalBlockReason(value: string): string {
  const reason = redactSensitiveOutput(String(value ?? '').trim())
    .replace(/\s+/g, ' ')
    .slice(0, 500)
  if (!reason)
    throw new GoalBlockerFactIssuerError(
      'goal_block_reason_invalid',
      'Goal blocker reason is required.',
    )
  return reason
}

function exactCauseReceipt(
  value: GoalBlockerCauseReceipt | null,
  goal: GoalRecord,
  code: GoalTypedBlockerCode,
): value is GoalBlockerCauseReceipt {
  return Boolean(
    value &&
    value.kind === 'core_goal_blocker_cause' &&
    value.issuedBy === 'core' &&
    value.goalId === goal.id &&
    value.goalEventSeq === goal.lastEventSeq &&
    value.cause === code &&
    value.blocking === true &&
    String(value.receiptId ?? '').trim() &&
    String(value.version ?? '').trim() &&
    /^[a-f0-9]{64}$/.test(String(value.integritySha256 ?? '')),
  )
}

function parseFact(value: unknown): GoalBlockerFact {
  if (!isRecord(value)) throw new Error('invalid Goal blocker fact')
  const base = {
    schemaVersion:
      value.schemaVersion === 'cairn.goal.blocker-fact.v1'
        ? ('cairn.goal.blocker-fact.v1' as const)
        : fail(),
    kind:
      value.kind === 'core_goal_blocker'
        ? ('core_goal_blocker' as const)
        : fail(),
    goalId: requiredText(value.goalId),
    goalEventSeq: requiredEventSeq(value.goalEventSeq),
    code: validCode(value.code),
    blocking: value.blocking === true ? (true as const) : fail(),
    source: value.source === 'core' ? ('core' as const) : fail(),
    reasonSha256: requiredSha256(value.reasonSha256),
    evidenceReceiptId: requiredText(value.evidenceReceiptId),
    evidenceVersion: requiredText(value.evidenceVersion),
    createdAt: requiredTimestamp(value.createdAt),
  }
  const version = requiredText(value.version)
  if (version !== `blocker:${sha256(canonicalJson(base))}`) fail()
  const withVersion = { ...base, version }
  const integritySha256 = requiredSha256(value.integritySha256)
  if (integritySha256 !== sha256(canonicalJson(withVersion))) fail()
  return Object.freeze({ ...withVersion, integritySha256 })
}

function validCode(value: unknown): GoalTypedBlockerCode {
  if (
    value === 'external_dependency' ||
    value === 'missing_permission' ||
    value === 'missing_access' ||
    value === 'unrecoverable_ambiguity' ||
    value === 'safety_policy'
  )
    return value
  return fail()
}

function requiredText(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) throw new Error('invalid Goal blocker fact')
  return text
}

function requiredSha256(value: unknown): string {
  const text = String(value ?? '')
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('invalid Goal blocker fact')
  return text
}

function requiredEventSeq(value: unknown): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1)
    throw new Error('invalid Goal blocker fact')
  return number
}

function requiredTimestamp(value: unknown): string {
  const timestamp = String(value ?? '')
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error('invalid Goal blocker fact')
  return timestamp
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function fail(): never {
  throw new Error('invalid Goal blocker fact')
}
