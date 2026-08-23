import { isAbsolute, normalize } from 'node:path'
import { z } from 'zod'
import { stableEnvironmentHash } from '../environment/models'
import { CairnError } from '../errors'
import { newId } from '../util/ids'
import {
  DEFAULT_GOAL_GUARD_POLICY,
  GOAL_PHASES,
  GOAL_SCHEMA_VERSION,
  GOAL_STATUSES,
  isGoalTerminal,
  type GoalAcceptanceCriterion,
  type GoalContract,
  type GoalContractDefinition,
  type GoalGuardPolicy,
  type GoalPhase,
  type GoalRecord,
  type GoalScope,
  type GoalStatus,
} from './models'
import { portableGoalWorkspace } from './scope'

export type GoalErrorCode =
  | 'goal_acceptance_description_invalid'
  | 'goal_acceptance_id_duplicate'
  | 'goal_acceptance_id_invalid'
  | 'goal_acceptance_required_missing'
  | 'goal_acceptance_requirement_invalid'
  | 'goal_acceptance_sequence_invalid'
  | 'goal_contract_immutable'
  | 'goal_contract_lock_invalid'
  | 'goal_contract_locked'
  | 'goal_guard_policy_invalid'
  | 'goal_identity_immutable'
  | 'goal_outcome_immutable'
  | 'goal_outcome_invalid'
  | 'goal_record_invalid'
  | 'goal_schema_version_unsupported'
  | 'goal_scope_conflict'
  | 'goal_scope_immutable'
  | 'goal_scope_invalid'
  | 'goal_scope_mismatch'
  | 'goal_state_combination_invalid'
  | 'goal_transition_invalid'

export class GoalDomainError extends CairnError {
  constructor(code: GoalErrorCode, message: string) {
    super(message, code)
  }
}

export interface NewGoalRecordInput {
  readonly id?: string
  readonly outcome: string
  readonly scope: {
    readonly sessionId: string
    readonly mode: 'chat' | 'build'
    readonly projectId: string | null
    readonly workspaceRoot: string
  }
  readonly contract?: Partial<GoalContractDefinition> | null
  readonly guardPolicy?: Partial<GoalGuardPolicy> | null
  readonly supersedesGoalId?: string | null
  readonly now?: string
}

const AC_ID_PATTERN = /^AC-([1-9][0-9]*)$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

const isoTimestampSchema = z.string().refine(isIsoTimestamp)
const nullableIdSchema = z.string().trim().min(1).nullable().optional()
const acceptanceCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  required: z.boolean(),
  verification: z.object({
    kind: z.enum(['command', 'artifact', 'manual', 'reviewer']),
    requirement: z.string(),
  }),
})
const contractSchema = z.object({
  outcome: z.string(),
  inScope: z.array(z.string()).optional(),
  outOfScope: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).optional(),
  escalationConditions: z.array(z.string()).optional(),
  lockedAt: isoTimestampSchema.nullable().optional(),
  revision: z.literal(1).optional(),
})
const contractDefinitionSchema = z
  .object({
    inScope: z.array(z.string()).optional(),
    outOfScope: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).optional(),
    escalationConditions: z.array(z.string()).optional(),
  })
  .strict()
const scopeSchema = z.object({
  sessionId: z.string().trim().min(1),
  mode: z.enum(['chat', 'build']),
  projectId: nullableIdSchema,
  workspaceRoot: z.string().refine((value) => value.trim().length > 0),
  projectFingerprint: z.string().regex(SHA256_PATTERN).nullable().optional(),
})
const runtimeSchema = z.object({
  phase: z.enum(GOAL_PHASES),
  cyclesUsed: z.number().int().nonnegative(),
  consecutiveNoEvidenceCycles: z.number().int().nonnegative(),
  currentRunId: nullableIdSchema,
  currentPlanId: nullableIdSchema,
  pendingInteractionId: nullableIdSchema,
  lastEvidenceAt: isoTimestampSchema.nullable().optional(),
  pauseReason: nullableIdSchema,
})
const guardPolicySchema = z.object({
  maxCycles: z.number().nullable().optional(),
  deadlineAt: z.string().nullable().optional(),
  maxEstimatedCostUsd: z.number().nullable().optional(),
  noEvidencePauseAfterCycles: z.number().optional(),
})
const goalRecordSchema = z.object({
  schemaVersion: z.literal(GOAL_SCHEMA_VERSION),
  id: z.string().trim().min(1),
  status: z.enum(GOAL_STATUSES),
  scope: scopeSchema,
  contract: contractSchema,
  runtime: runtimeSchema,
  guardPolicy: guardPolicySchema.optional(),
  latestEvidenceByCriterion: z
    .record(z.string(), z.string().trim().min(1))
    .optional(),
  supersedesGoalId: nullableIdSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  terminalAt: isoTimestampSchema.nullable().optional(),
  lastEventSeq: z.number().int().nonnegative().optional(),
})

type ParsedGoalRecord = z.infer<typeof goalRecordSchema>
type ParsedContractDefinition = z.infer<typeof contractDefinitionSchema>

export const GOAL_STATUS_TRANSITIONS: Readonly<
  Record<GoalStatus, readonly GoalStatus[]>
> = Object.freeze({
  draft: frozenStatuses('draft', 'active', 'cancelled'),
  active: frozenStatuses(
    'active',
    'completed',
    'blocked',
    'cancelled',
    'stopped_by_policy',
  ),
  completed: frozenStatuses('completed'),
  blocked: frozenStatuses('blocked'),
  cancelled: frozenStatuses('cancelled'),
  stopped_by_policy: frozenStatuses('stopped_by_policy'),
})

export const GOAL_PHASE_TRANSITIONS: Readonly<
  Record<GoalPhase, readonly GoalPhase[]>
> = Object.freeze({
  contract: frozenPhases('contract', 'planning', 'paused', 'terminal'),
  planning: frozenPhases(
    'planning',
    'executing',
    'awaiting_user',
    'paused',
    'terminal',
  ),
  executing: frozenPhases(
    'executing',
    'verifying',
    'planning',
    'awaiting_user',
    'paused',
    'terminal',
  ),
  verifying: frozenPhases(
    'verifying',
    'executing',
    'awaiting_user',
    'paused',
    'terminal',
  ),
  awaiting_user: frozenPhases(
    'awaiting_user',
    'contract',
    'planning',
    'executing',
    'verifying',
    'paused',
    'terminal',
  ),
  paused: frozenPhases(
    'paused',
    'contract',
    'planning',
    'executing',
    'verifying',
    'terminal',
  ),
  terminal: frozenPhases('terminal'),
})

export function newGoalRecord(input: NewGoalRecordInput): GoalRecord {
  const now = input.now ?? new Date().toISOString()
  assertIsoTimestamp(now)
  const scope = normalizeScope(input.scope)
  const definition = parseContractDefinition(input.contract ?? {})
  const contract = normalizeContract(
    normalizeOutcome(input.outcome),
    definition,
    null,
    false,
  )
  return freezeGoalRecord({
    schemaVersion: GOAL_SCHEMA_VERSION,
    id: normalizeId(input.id ?? newId('goal_')),
    status: 'draft',
    scope,
    contract,
    runtime: {
      phase: 'contract',
      cyclesUsed: 0,
      consecutiveNoEvidenceCycles: 0,
      currentRunId: null,
      currentPlanId: null,
      pendingInteractionId: null,
      lastEvidenceAt: null,
      pauseReason: null,
    },
    guardPolicy: normalizeGuardPolicy(input.guardPolicy),
    latestEvidenceByCriterion: {},
    supersedesGoalId: normalizeNullableId(input.supersedesGoalId),
    createdAt: now,
    updatedAt: now,
    terminalAt: null,
    lastEventSeq: 0,
  })
}

export function parseGoalRecord(value: unknown): GoalRecord {
  if (
    isRecord(value) &&
    Object.hasOwn(value, 'schemaVersion') &&
    value.schemaVersion !== GOAL_SCHEMA_VERSION
  ) {
    throw goalError(
      'goal_schema_version_unsupported',
      'Goal schema version is not supported.',
    )
  }
  const result = goalRecordSchema.safeParse(value)
  if (!result.success)
    throw goalError('goal_record_invalid', 'Goal record is invalid.')

  const parsed = result.data
  const scope = normalizeScope(parsed.scope, {
    savedFingerprint: parsed.scope.projectFingerprint,
    allowMissingFingerprint:
      parsed.status === 'draft' &&
      (parsed.contract.lockedAt === null ||
        parsed.contract.lockedAt === undefined),
  })
  const contract = normalizeContract(
    normalizeOutcome(parsed.contract.outcome),
    parsed.contract,
    parsed.contract.lockedAt ?? null,
    parsed.contract.lockedAt !== null && parsed.contract.lockedAt !== undefined,
  )
  const record: GoalRecord = {
    schemaVersion: GOAL_SCHEMA_VERSION,
    id: parsed.id,
    status: parsed.status,
    scope,
    contract,
    runtime: {
      phase: parsed.runtime.phase,
      cyclesUsed: parsed.runtime.cyclesUsed,
      consecutiveNoEvidenceCycles: parsed.runtime.consecutiveNoEvidenceCycles,
      currentRunId: parsed.runtime.currentRunId ?? null,
      currentPlanId: parsed.runtime.currentPlanId ?? null,
      pendingInteractionId: parsed.runtime.pendingInteractionId ?? null,
      lastEvidenceAt: parsed.runtime.lastEvidenceAt ?? null,
      pauseReason: parsed.runtime.pauseReason ?? null,
    },
    guardPolicy: normalizeGuardPolicy(parsed.guardPolicy),
    latestEvidenceByCriterion: {
      ...(parsed.latestEvidenceByCriterion ?? {}),
    },
    supersedesGoalId: parsed.supersedesGoalId ?? null,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    terminalAt: parsed.terminalAt ?? null,
    lastEventSeq: parsed.lastEventSeq ?? 0,
  }
  validateEvidenceProjection(record)
  validateStateCombination(record)
  return freezeGoalRecord(record)
}

export class GoalContractValidator {
  static lock(
    record: GoalRecord,
    definition: GoalContractDefinition,
    lockedAt = new Date().toISOString(),
  ): GoalRecord {
    if (record.contract.lockedAt !== null)
      throw goalError(
        'goal_contract_locked',
        'Goal contract is already locked.',
      )
    if (record.status !== 'draft' || record.runtime.phase !== 'contract')
      throw goalError(
        'goal_contract_lock_invalid',
        'Goal contract cannot be locked in the current state.',
      )
    if (isRecord(definition) && Object.hasOwn(definition, 'outcome'))
      throw goalError(
        'goal_outcome_immutable',
        'Goal outcome cannot be changed by contract definition.',
      )
    assertIsoTimestamp(lockedAt)
    const current = parseGoalRecord(record)
    const nextContract = normalizeContract(
      current.contract.outcome,
      parseContractDefinition(definition),
      lockedAt,
      true,
    )
    const next: GoalRecord = {
      ...current,
      status: 'active',
      contract: nextContract,
      runtime: { ...current.runtime, phase: 'planning' },
      updatedAt: lockedAt,
    }
    return assertGoalTransition(current, next)
  }
}

export function assertGoalTransition(
  currentValue: GoalRecord,
  nextValue: GoalRecord,
): GoalRecord {
  if (currentValue === nextValue)
    throw goalError(
      'goal_transition_invalid',
      'Goal transition requires distinct snapshots.',
    )
  if (!sameScope(currentValue.scope, nextValue.scope))
    throw goalError('goal_scope_immutable', 'Goal scope cannot be changed.')
  if (
    currentValue.id !== nextValue.id ||
    currentValue.schemaVersion !== nextValue.schemaVersion ||
    currentValue.createdAt !== nextValue.createdAt ||
    currentValue.supersedesGoalId !== nextValue.supersedesGoalId
  ) {
    throw goalError(
      'goal_identity_immutable',
      'Goal identity cannot be changed.',
    )
  }
  if (currentValue.contract.outcome !== nextValue.contract.outcome)
    throw goalError('goal_outcome_immutable', 'Goal outcome cannot be changed.')

  const current = parseGoalRecord(currentValue)
  const next = parseGoalRecord(nextValue)
  if (
    current.contract.lockedAt !== null &&
    !sameJson(current.contract, next.contract)
  ) {
    throw goalError(
      'goal_contract_immutable',
      'Locked Goal contract cannot be changed.',
    )
  }
  if (
    current.contract.lockedAt === null &&
    !sameJson(current.contract, next.contract) &&
    !isContractLockTransition(current, next)
  ) {
    throw goalError(
      'goal_contract_immutable',
      'Goal contract can only change while it is being locked.',
    )
  }
  if (!GOAL_STATUS_TRANSITIONS[current.status].includes(next.status))
    throw goalError(
      'goal_transition_invalid',
      'Goal status transition is not allowed.',
    )
  if (
    !GOAL_PHASE_TRANSITIONS[current.runtime.phase].includes(next.runtime.phase)
  )
    throw goalError(
      'goal_transition_invalid',
      'Goal phase transition is not allowed.',
    )
  if (
    isGoalTerminal(current.status) &&
    (current.status !== next.status || next.runtime.phase !== 'terminal')
  ) {
    throw goalError(
      'goal_transition_invalid',
      'Terminal Goal state cannot be changed.',
    )
  }
  return next
}

function normalizeContract(
  outcome: string,
  definition: ParsedContractDefinition | ParsedGoalRecord['contract'],
  lockedAt: string | null,
  requireRequiredCriterion: boolean,
): GoalContract {
  const inScope = normalizeStringList(definition.inScope)
  const outOfScope = normalizeStringList(definition.outOfScope)
  const outKeys = new Set(outOfScope.map(normalizedListKey))
  if (inScope.some((entry) => outKeys.has(normalizedListKey(entry))))
    throw goalError(
      'goal_scope_conflict',
      'Goal in-scope and out-of-scope entries must not overlap.',
    )
  const acceptanceCriteria = normalizeAcceptanceCriteria(
    definition.acceptanceCriteria ?? [],
    requireRequiredCriterion,
  )
  return {
    outcome,
    inScope,
    outOfScope,
    constraints: normalizeStringList(definition.constraints),
    acceptanceCriteria,
    escalationConditions: normalizeStringList(definition.escalationConditions),
    lockedAt,
    revision: 1,
  }
}

function normalizeAcceptanceCriteria(
  criteria: GoalAcceptanceCriterion[],
  requireRequiredCriterion: boolean,
): GoalAcceptanceCriterion[] {
  const normalized: GoalAcceptanceCriterion[] = []
  const seen = new Set<string>()
  for (const [index, criterion] of criteria.entries()) {
    const id = criterion.id.trim()
    const match = AC_ID_PATTERN.exec(id)
    if (!match)
      throw goalError(
        'goal_acceptance_id_invalid',
        'Goal acceptance criterion ID is invalid.',
      )
    if (seen.has(id))
      throw goalError(
        'goal_acceptance_id_duplicate',
        'Goal acceptance criterion IDs must be unique.',
      )
    seen.add(id)
    if (Number(match[1]) !== index + 1)
      throw goalError(
        'goal_acceptance_sequence_invalid',
        'Goal acceptance criterion IDs must be consecutive.',
      )
    const description = criterion.description.trim()
    if (!description)
      throw goalError(
        'goal_acceptance_description_invalid',
        'Goal acceptance criterion description is required.',
      )
    const requirement = criterion.verification.requirement.trim()
    if (!requirement)
      throw goalError(
        'goal_acceptance_requirement_invalid',
        'Goal acceptance criterion verification is required.',
      )
    normalized.push({
      id,
      description,
      required: criterion.required,
      verification: {
        kind: criterion.verification.kind,
        requirement,
      },
    })
  }
  if (
    requireRequiredCriterion &&
    !normalized.some((criterion) => criterion.required)
  ) {
    throw goalError(
      'goal_acceptance_required_missing',
      'Goal contract requires at least one required acceptance criterion.',
    )
  }
  return normalized
}

function normalizeScope(
  value: NewGoalRecordInput['scope'] | ParsedGoalRecord['scope'],
  binding?: {
    readonly savedFingerprint: string | null | undefined
    readonly allowMissingFingerprint: boolean
  },
): GoalScope {
  const sessionId = normalizeScopeId(value.sessionId)
  const projectId = normalizeNullableId(value.projectId)
  if (value.mode !== 'chat' && value.mode !== 'build')
    throw goalError('goal_scope_invalid', 'Goal scope is invalid.')
  const rawRoot = String(value.workspaceRoot ?? '')
  if (!rawRoot.trim())
    throw goalError('goal_scope_invalid', 'Goal scope is invalid.')
  if (!isAbsolute(rawRoot))
    throw goalError('goal_scope_invalid', 'Goal scope is invalid.')
  const workspaceRoot = portableGoalWorkspace(normalize(rawRoot))
  const projectFingerprint = stableEnvironmentHash(
    value.mode === 'chat'
      ? { mode: value.mode, workspaceRoot }
      : { mode: value.mode, projectId, workspaceRoot },
  )
  const savedFingerprint = binding?.savedFingerprint
  const fingerprintMissing =
    savedFingerprint === undefined || savedFingerprint === null
  if (
    binding &&
    ((fingerprintMissing && !binding.allowMissingFingerprint) ||
      (!fingerprintMissing && savedFingerprint !== projectFingerprint))
  ) {
    throw goalError(
      'goal_scope_mismatch',
      'Goal scope fingerprint does not match its project binding.',
    )
  }
  return {
    sessionId,
    mode: value.mode,
    projectId,
    workspaceRoot,
    projectFingerprint,
  }
}

function normalizeGuardPolicy(
  value: Partial<GoalGuardPolicy> | null | undefined,
): GoalGuardPolicy {
  const policy: GoalGuardPolicy = {
    ...DEFAULT_GOAL_GUARD_POLICY,
    ...(value ?? {}),
  }
  if (
    (policy.maxCycles !== null &&
      (!Number.isInteger(policy.maxCycles) || policy.maxCycles <= 0)) ||
    (policy.maxEstimatedCostUsd !== null &&
      (!Number.isFinite(policy.maxEstimatedCostUsd) ||
        policy.maxEstimatedCostUsd <= 0)) ||
    !Number.isInteger(policy.noEvidencePauseAfterCycles) ||
    policy.noEvidencePauseAfterCycles < 1 ||
    policy.noEvidencePauseAfterCycles > 20 ||
    (policy.deadlineAt !== null && !isIsoTimestamp(policy.deadlineAt))
  ) {
    throw goalError(
      'goal_guard_policy_invalid',
      'Goal guard policy is invalid.',
    )
  }
  return policy
}

function validateStateCombination(record: GoalRecord): void {
  const terminal = isGoalTerminal(record.status)
  const draftValid =
    record.status === 'draft' &&
    (record.runtime.phase === 'contract' ||
      record.runtime.phase === 'paused') &&
    record.contract.lockedAt === null &&
    record.terminalAt === null
  const activeValid =
    record.status === 'active' &&
    record.runtime.phase !== 'contract' &&
    record.runtime.phase !== 'terminal' &&
    record.contract.lockedAt !== null &&
    record.terminalAt === null
  const cancelledValid =
    record.status === 'cancelled' &&
    record.runtime.phase === 'terminal' &&
    record.terminalAt !== null
  const otherTerminalValid =
    terminal &&
    record.status !== 'cancelled' &&
    record.runtime.phase === 'terminal' &&
    record.contract.lockedAt !== null &&
    record.terminalAt !== null
  if (!draftValid && !activeValid && !cancelledValid && !otherTerminalValid)
    throw goalError(
      'goal_state_combination_invalid',
      'Goal status and phase combination is invalid.',
    )
}

function validateEvidenceProjection(record: GoalRecord): void {
  const criterionIds = new Set(
    record.contract.acceptanceCriteria.map((criterion) => criterion.id),
  )
  if (
    Object.keys(record.latestEvidenceByCriterion).some(
      (criterionId) => !criterionIds.has(criterionId),
    )
  ) {
    throw goalError('goal_record_invalid', 'Goal record is invalid.')
  }
}

function isContractLockTransition(
  current: GoalRecord,
  next: GoalRecord,
): boolean {
  return (
    current.status === 'draft' &&
    current.runtime.phase === 'contract' &&
    current.contract.lockedAt === null &&
    next.status === 'active' &&
    next.runtime.phase === 'planning' &&
    next.contract.lockedAt !== null &&
    next.contract.outcome === current.contract.outcome
  )
}

function parseContractDefinition(
  value: Partial<GoalContractDefinition>,
): ParsedContractDefinition {
  const result = contractDefinitionSchema.safeParse(value)
  if (!result.success)
    throw goalError('goal_record_invalid', 'Goal contract is invalid.')
  return result.data
}

function normalizeOutcome(value: string): string {
  const outcome = String(value ?? '').trim()
  if (outcome.length < 1 || outcome.length > 4000)
    throw goalError(
      'goal_outcome_invalid',
      'Goal outcome must contain 1 to 4000 characters.',
    )
  return outcome
}

function normalizeStringList(value: string[] | undefined): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value ?? []) {
    const normalized = item.trim().replace(/\s+/g, ' ')
    if (!normalized) continue
    const key = normalizedListKey(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

function freezeGoalRecord(record: GoalRecord): GoalRecord {
  return deepFreeze(record)
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value))
    return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function normalizedListKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
}

function normalizeId(value: string): string {
  const id = String(value ?? '').trim()
  if (!id) throw goalError('goal_record_invalid', 'Goal record is invalid.')
  return id
}

function normalizeScopeId(value: string): string {
  const id = String(value ?? '').trim()
  if (!id) throw goalError('goal_scope_invalid', 'Goal scope is invalid.')
  return id
}

function normalizeNullableId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const id = String(value).trim()
  if (!id) throw goalError('goal_record_invalid', 'Goal record is invalid.')
  return id
}

function assertIsoTimestamp(value: string): void {
  if (!isIsoTimestamp(value))
    throw goalError('goal_record_invalid', 'Goal timestamp is invalid.')
}

function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
    return false
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return false
  const normalized = value.includes('.') ? value : value.replace('Z', '.000Z')
  return new Date(timestamp).toISOString() === normalized
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameScope(left: GoalScope, right: GoalScope): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.mode === right.mode &&
    left.projectId === right.projectId &&
    left.workspaceRoot === right.workspaceRoot &&
    left.projectFingerprint === right.projectFingerprint
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function goalError(code: GoalErrorCode, message: string): GoalDomainError {
  return new GoalDomainError(code, message)
}

function frozenStatuses(...statuses: GoalStatus[]): readonly GoalStatus[] {
  return Object.freeze(statuses)
}

function frozenPhases(...phases: GoalPhase[]): readonly GoalPhase[] {
  return Object.freeze(phases)
}
