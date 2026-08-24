import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CairnError } from '../errors'
import { canonicalJson } from './events'
import {
  syncDirectoryBestEffortSync,
  syncFileBestEffortSync,
} from '../util/fs-durability'
import {
  compareStableProcessStartIdentity,
  currentStableProcessIdentity,
  parseStableProcessStartIdentity,
  pidIsAlive,
  stableProcessStartIdentity,
  type StableProcessStartIdentity,
} from '../util/stable-process-identity'

const OWNER_SCHEMA = 'cairn.goal.mutation-guard-owner' as const
const PREVIOUS_OWNER_SCHEMA = 'cairn.goal.mutation-guard-owner.v2' as const
const DEFAULT_STALE_MS = 30_000
const DEFAULT_TIMEOUT_MS = 5_000
const SYNC_RETRY_MS = 2

type GoalMutationPurpose = 'mutation' | 'terminal' | 'diagnostic'

interface GoalMutationOwner {
  readonly schemaVersion: typeof OWNER_SCHEMA
  readonly pid: number
  readonly hostname: string
  readonly nonce: string
  readonly purpose: GoalMutationPurpose
  readonly acquiredAt: string
  readonly bootMarker: string | null
  readonly processStartIdentity: StableProcessStartIdentity | null
}

export type GoalMutationOwnerStatus =
  | 'missing'
  | 'active'
  | 'dead'
  | 'pid_reused'
  | 'previous_boot'
  | 'ambiguous'
  | 'corrupt'

export interface GoalMutationOwnerDiagnostic {
  readonly status: GoalMutationOwnerStatus
  readonly path: string
  readonly nonce: string | null
  readonly acquiredAt: string | null
  readonly ownerSha256: string | null
  readonly pathIdentitySha256: string | null
}

export type GoalMutationRecoveryMarkerStatus =
  'missing' | 'active' | 'stale' | 'ambiguous' | 'corrupt'

export type GoalMutationRecoveryMarkerOwnerStatus =
  'active' | 'stale' | 'ambiguous'

export interface GoalMutationRecoveryMarkerDiagnostic {
  readonly status: GoalMutationRecoveryMarkerStatus
  readonly markerPath: string
  readonly rawMarkerSha256: string | null
  readonly recoveryId: string | null
  readonly intentPath: string | null
  readonly intentSha256: string | null
  readonly intentValid: boolean
  readonly expectedOwnerSha256: string | null
  readonly expectedPathIdentitySha256: string | null
  readonly expectedNonce: string | null
  readonly currentOwner: GoalMutationOwnerDiagnostic
  readonly markerOwnerStatus: GoalMutationRecoveryMarkerOwnerStatus | null
}

export interface RecoverStaleGoalMutationMarkerInput {
  readonly expectedRawMarkerSha256: string
  readonly expectedRecoveryId: string
  readonly expectedIntentSha256: string
  readonly expectedOwnerSha256: string | null
  readonly expectedPathIdentitySha256: string | null
  readonly expectedNonce: string | null
  readonly confirmedMarkerStale: true
}

export class GoalMutationGuardError extends CairnError {
  constructor(code: string, message: string) {
    super(message, code)
  }
}

export class GoalMutationLease {
  readonly stateRoot: string
  readonly nonce: string
  readonly purpose: GoalMutationPurpose

  private constructor(owner: GoalMutationOwner, stateRoot: string) {
    this.stateRoot = stateRoot
    this.nonce = owner.nonce
    this.purpose = owner.purpose
  }

  static create(
    owner: GoalMutationOwner,
    stateRoot: string,
  ): GoalMutationLease {
    return new GoalMutationLease(owner, stateRoot)
  }
}

export class GoalMutationGuard {
  readonly stateRoot: string
  readonly path: string
  readonly recoveryAuditPath: string
  readonly recoveryIntentsDir: string
  readonly recoveryMarkerPath: string
  readonly operatorRecoveryClaimPath: string
  readonly operatorRecoveryReclaimBarrierPath: string
  private readonly operatorRecoveryReclaimerStateRoot: string
  private readonly staleMs: number
  private readonly timeoutMs: number
  private readonly beforeRecoveryAudit?: () => void
  private readonly beforeRecoveryCompletion?: () => void
  private readonly afterOperatorRecoveryClaim?: () => void
  private readonly beforeMarkerRecoveryCompletion?: () => void
  private readonly beforeMarkerRecoveryRemove?: () => void
  private readonly afterOperatorReclaimClaimed?: () => void

  constructor(
    stateRoot: string,
    options: {
      readonly staleMs?: number
      readonly timeoutMs?: number
      readonly beforeRecoveryAudit?: () => void
      readonly beforeRecoveryCompletion?: () => void
      readonly afterOperatorRecoveryClaim?: () => void
      readonly beforeMarkerRecoveryCompletion?: () => void
      readonly beforeMarkerRecoveryRemove?: () => void
      readonly afterOperatorReclaimClaimed?: () => void
    } = {},
  ) {
    this.stateRoot = resolve(stateRoot)
    // Leading dot keeps this coordination path out of Goal ID scans.
    this.path = join(this.stateRoot, 'goals', '.mutation.guard')
    this.recoveryMarkerPath = `${this.path}.recovery`
    this.operatorRecoveryClaimPath = `${this.recoveryMarkerPath}.operator`
    this.operatorRecoveryReclaimerStateRoot = `${this.operatorRecoveryClaimPath}.reclaimer-state`
    this.operatorRecoveryReclaimBarrierPath = join(
      this.operatorRecoveryReclaimerStateRoot,
      'goals',
      '.mutation.guard',
    )
    this.recoveryAuditPath = join(
      this.stateRoot,
      'goals',
      'mutation-guard-recovery.jsonl',
    )
    this.recoveryIntentsDir = join(
      this.stateRoot,
      'goals',
      'mutation-guard-recovery-intents',
    )
    this.staleMs = Math.max(1_000, options.staleMs ?? DEFAULT_STALE_MS)
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.beforeRecoveryAudit = options.beforeRecoveryAudit
    this.beforeRecoveryCompletion = options.beforeRecoveryCompletion
    this.afterOperatorRecoveryClaim = options.afterOperatorRecoveryClaim
    this.beforeMarkerRecoveryCompletion = options.beforeMarkerRecoveryCompletion
    this.beforeMarkerRecoveryRemove = options.beforeMarkerRecoveryRemove
    this.afterOperatorReclaimClaimed = options.afterOperatorReclaimClaimed
  }

  /** New locks are files; this getter also exposes the legacy directory owner. */
  get ownerPath(): string {
    return ownerDocumentPath(this.path)
  }

  async runExclusive<T>(
    purpose: GoalMutationPurpose,
    action: (lease: GoalMutationLease) => T | Promise<T>,
  ): Promise<T> {
    this.assertNotLocallyNested(purpose)
    const deadline = Date.now() + this.timeoutMs
    let owner: GoalMutationOwner | null = null
    while (!owner) {
      owner = this.tryAcquire(purpose)
      if (owner) break
      if (Date.now() >= deadline) throw this.busyError()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const lease = GoalMutationLease.create(owner, this.stateRoot)
    const heartbeat = setInterval(() => this.heartbeat(lease), this.staleMs / 3)
    heartbeat.unref()
    try {
      return await ACTIVE_ASYNC_LEASE.run(
        lease,
        async () => await action(lease),
      )
    } finally {
      clearInterval(heartbeat)
      this.release(lease)
    }
  }

  runExclusiveSync<T>(
    purpose: Exclude<GoalMutationPurpose, 'terminal'>,
    action: (lease: GoalMutationLease) => T,
  ): T {
    this.assertNotLocallyNested(purpose)
    const deadline = Date.now() + this.timeoutMs
    let owner: GoalMutationOwner | null = null
    while (!owner) {
      owner = this.tryAcquire(purpose)
      if (owner) break
      const current = this.readOwner()
      if (current?.purpose === 'terminal' || Date.now() >= deadline)
        throw this.busyError()
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        SYNC_RETRY_MS,
      )
    }
    const lease = GoalMutationLease.create(owner, this.stateRoot)
    ACTIVE_SYNC_LEASES.set(this.stateRoot, lease)
    try {
      return action(lease)
    } finally {
      ACTIVE_SYNC_LEASES.delete(this.stateRoot)
      this.release(lease)
    }
  }

  assertLease(lease: GoalMutationLease, purpose?: GoalMutationPurpose): void {
    const local = currentLocalLease(this.stateRoot)
    const owner = this.readOwner()
    if (
      local !== lease ||
      lease.stateRoot !== this.stateRoot ||
      owner?.nonce !== lease.nonce ||
      (purpose !== undefined && lease.purpose !== purpose)
    )
      throw new GoalMutationGuardError(
        'goal_mutation_guard_invalid_lease',
        'Goal mutation lease is unavailable or invalid.',
      )
  }

  diagnoseOwner(): GoalMutationOwnerDiagnostic {
    return diagnoseOwnerAt(this.path)
  }

  diagnoseRecoveryMarker(): GoalMutationRecoveryMarkerDiagnostic {
    return diagnoseRecoveryMarkerAt({
      markerPath: this.recoveryMarkerPath,
      ownerPath: this.path,
      intentsDir: this.recoveryIntentsDir,
    })
  }

  recoverStaleMarker(input: RecoverStaleGoalMutationMarkerInput): boolean {
    const first = this.resolveRecoveryMarkerForInput(
      this.diagnoseRecoveryMarker(),
      input,
    )
    if (!first) return false
    if (!this.matchesStaleMarkerRecoveryInput(first, input)) return false
    const claim = this.tryAcquireOperatorRecoveryClaim()
    if (!claim) return false
    try {
      this.afterOperatorRecoveryClaim?.()
      if (!this.ownsOperatorRecoveryClaim(claim)) return false
      const current = this.resolveRecoveryMarkerForInput(
        this.diagnoseRecoveryMarker(),
        input,
      )
      if (!current) return false
      if (
        canonicalJson(current) !== canonicalJson(first) ||
        !this.matchesStaleMarkerRecoveryInput(current, input)
      )
        return false
      const intent = readIntegrityRecord(current.intentPath!)
      if (
        !intent ||
        !isRecoveryIntentRecord(intent) ||
        intent.recoveryId !== input.expectedRecoveryId ||
        sha256Buffer(readFileSync(current.intentPath!)) !==
          input.expectedIntentSha256
      )
        return false
      const ownerMissing = current.currentOwner.status === 'missing'
      const ownerExact = recoveryOwnerMatchesIntent(
        current.currentOwner,
        intent,
      )
      if (!ownerMissing && !ownerExact) return false
      const operatorIntent = this.persistOperatorRecoveryIntent(
        current,
        intent,
        claim,
      )
      if (ownerExact) {
        const moved = this.diagnoseRecoveryMarker()
        if (
          moved.rawMarkerSha256 !== input.expectedRawMarkerSha256 ||
          !recoveryOwnerMatchesIntent(moved.currentOwner, intent)
        )
          return false
        if (!this.ownsOperatorRecoveryClaim(claim)) return false
        rmSync(this.path, { recursive: true, force: false })
        syncDirectoryBestEffortSync(dirname(this.path))
      }
      this.beforeMarkerRecoveryCompletion?.()
      this.appendRecoveryCompletion(intent)
      if (
        !recoveryAuditContains(this.recoveryAuditPath, input.expectedRecoveryId)
      )
        return false
      this.appendOperatorRecoveryCompletion(operatorIntent)
      this.beforeMarkerRecoveryRemove?.()
      if (!this.ownsOperatorRecoveryClaim(claim)) return false
      if (
        !removeExactRawFile(
          this.recoveryMarkerPath,
          input.expectedRawMarkerSha256,
        )
      )
        return false
      syncDirectoryBestEffortSync(dirname(this.recoveryMarkerPath))
      return true
    } catch {
      return false
    } finally {
      this.releaseOperatorRecoveryClaim(claim)
    }
  }

  private resolveRecoveryMarkerForInput(
    diagnostic: GoalMutationRecoveryMarkerDiagnostic,
    input: RecoverStaleGoalMutationMarkerInput,
  ): GoalMutationRecoveryMarkerDiagnostic | null {
    if (diagnostic.intentValid) return diagnostic
    const recoveryId = normalizeSha256(input.expectedRecoveryId)
    if (
      diagnostic.status !== 'corrupt' ||
      diagnostic.rawMarkerSha256 !==
        normalizeSha256(input.expectedRawMarkerSha256) ||
      !recoveryId ||
      (diagnostic.recoveryId !== null &&
        diagnostic.recoveryId !== recoveryId) ||
      !isNullableSha256(input.expectedOwnerSha256) ||
      !isNullableSha256(input.expectedPathIdentitySha256) ||
      !isNullableString(input.expectedNonce)
    )
      return null
    const path = join(this.recoveryIntentsDir, `${recoveryId}.json`)
    const intent = diagnoseRecoveryIntent(path, recoveryId)
    const record = intent.record
    if (
      !intent.valid ||
      !record ||
      intent.rawSha256 !== normalizeSha256(input.expectedIntentSha256) ||
      record.previousOwnerSha256 !== input.expectedOwnerSha256 ||
      record.previousPathIdentitySha256 !== input.expectedPathIdentitySha256 ||
      record.previousNonce !== input.expectedNonce
    )
      return null
    return Object.freeze({
      ...diagnostic,
      intentPath: path,
      intentSha256: intent.rawSha256,
      intentValid: true,
      expectedOwnerSha256: input.expectedOwnerSha256,
      expectedPathIdentitySha256: input.expectedPathIdentitySha256,
      expectedNonce: input.expectedNonce,
    })
  }

  private matchesStaleMarkerRecoveryInput(
    diagnostic: GoalMutationRecoveryMarkerDiagnostic,
    input: RecoverStaleGoalMutationMarkerInput,
  ): boolean {
    const recoveryId = normalizeSha256(input.expectedRecoveryId)
    return Boolean(
      input.confirmedMarkerStale === true &&
      (diagnostic.status === 'stale' ||
        diagnostic.status === 'ambiguous' ||
        diagnostic.status === 'corrupt') &&
      normalizeSha256(input.expectedRawMarkerSha256) ===
        diagnostic.rawMarkerSha256 &&
      recoveryId &&
      (diagnostic.recoveryId === null ||
        diagnostic.recoveryId === recoveryId) &&
      diagnostic.intentPath ===
        join(this.recoveryIntentsDir, `${recoveryId}.json`) &&
      diagnostic.intentValid &&
      normalizeSha256(input.expectedIntentSha256) === diagnostic.intentSha256 &&
      isNullableSha256(input.expectedOwnerSha256) &&
      input.expectedOwnerSha256 === diagnostic.expectedOwnerSha256 &&
      isNullableSha256(input.expectedPathIdentitySha256) &&
      input.expectedPathIdentitySha256 ===
        diagnostic.expectedPathIdentitySha256 &&
      isNullableString(input.expectedNonce) &&
      input.expectedNonce === diagnostic.expectedNonce &&
      (diagnostic.currentOwner.status === 'missing' ||
        (diagnostic.currentOwner.status !== 'active' &&
          diagnostic.currentOwner.ownerSha256 ===
            diagnostic.expectedOwnerSha256 &&
          diagnostic.currentOwner.pathIdentitySha256 ===
            diagnostic.expectedPathIdentitySha256 &&
          diagnostic.currentOwner.nonce === diagnostic.expectedNonce)),
    )
  }

  /**
   * Explicit recovery for a corrupt or ambiguous stale owner. The caller must
   * confirm the exact raw owner bytes, plus the nonce when one is readable.
   */
  recoverStaleOwner(input: {
    readonly expectedOwnerSha256?: string | null
    readonly expectedPathIdentitySha256?: string | null
    readonly expectedNonce?: string | null
    readonly confirmedOwnerStale: true
  }): boolean {
    const diagnostic = this.diagnoseOwner()
    const rawOwnerMatches =
      diagnostic.ownerSha256 !== null &&
      diagnostic.ownerSha256 === normalizeSha256(input.expectedOwnerSha256)
    const ownerlessPathMatches =
      diagnostic.ownerSha256 === null &&
      diagnostic.pathIdentitySha256 !== null &&
      diagnostic.pathIdentitySha256 ===
        normalizeSha256(input.expectedPathIdentitySha256)
    if (
      input.confirmedOwnerStale !== true ||
      (diagnostic.status !== 'ambiguous' && diagnostic.status !== 'corrupt') ||
      (!rawOwnerMatches && !ownerlessPathMatches) ||
      (diagnostic.nonce !== null &&
        diagnostic.nonce !== String(input.expectedNonce ?? '').trim())
    )
      return false
    return this.removeOwner(
      diagnostic,
      diagnostic.status === 'corrupt'
        ? 'operator-corrupt-recovery'
        : 'operator-ambiguous-recovery',
    )
  }

  private tryAcquireOperatorRecoveryClaim(): GoalMutationOwner | null {
    mkdirSync(dirname(this.operatorRecoveryClaimPath), {
      recursive: true,
      mode: 0o700,
    })
    const identity = currentStableProcessIdentity()
    if (!identity.bootMarker || !identity.processStartIdentity) return null
    const owner: GoalMutationOwner = {
      schemaVersion: OWNER_SCHEMA,
      pid: process.pid,
      hostname: hostname(),
      nonce: randomUUID(),
      purpose: 'diagnostic',
      acquiredAt: new Date().toISOString(),
      bootMarker: identity.bootMarker,
      processStartIdentity: identity.processStartIdentity,
    }
    const temporary = `${this.operatorRecoveryClaimPath}.claim-${owner.nonce}`
    try {
      writeFileSync(temporary, JSON.stringify(owner), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      syncFileStrictSync(temporary)
      if (this.publishOperatorRecoveryClaim(temporary)) return owner

      const observed = diagnoseOwnerAt(this.operatorRecoveryClaimPath)
      if (!isAutomaticallyRecoverableOwner(observed)) return null
      let readyForAcquire = false
      const reclaimer = new GoalMutationGuard(
        this.operatorRecoveryReclaimerStateRoot,
        {
          staleMs: 1_000,
          timeoutMs: Math.max(2_000, this.timeoutMs),
        },
      )
      try {
        reclaimer.runExclusiveSync('diagnostic', () => {
          const pinned = diagnoseOwnerAt(this.operatorRecoveryClaimPath)
          if (pinned.status === 'missing') {
            readyForAcquire = true
            return
          }
          if (!isAutomaticallyRecoverableOwner(pinned)) return
          this.afterOperatorReclaimClaimed?.()
          const current = diagnoseOwnerAt(this.operatorRecoveryClaimPath)
          if (!sameOwnerDiagnostic(current, pinned)) return
          rmSync(this.operatorRecoveryClaimPath, { force: false })
          syncDirectoryBestEffortSync(dirname(this.operatorRecoveryClaimPath))
          readyForAcquire = true
        })
      } catch (error) {
        if (
          error instanceof GoalMutationGuardError &&
          error.code === 'goal_mutation_guard_busy'
        )
          return null
        throw error
      }
      // The reclaimer lease is gone before contenders race on the ordinary,
      // no-clobber claim path. No helper ever unlinks a replacement claim.
      return readyForAcquire && this.publishOperatorRecoveryClaim(temporary)
        ? owner
        : null
    } catch (error) {
      if (isUnsupportedHardlinkError(error))
        throw new GoalMutationGuardError(
          'goal_mutation_guard_atomic_link_unsupported',
          'Goal state root filesystem must support atomic hard links.',
        )
      throw error
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  private publishOperatorRecoveryClaim(temporary: string): boolean {
    try {
      linkSync(temporary, this.operatorRecoveryClaimPath)
      syncDirectoryBestEffortSync(dirname(this.operatorRecoveryClaimPath))
      return true
    } catch (error) {
      if (isUnsupportedHardlinkError(error))
        throw new GoalMutationGuardError(
          'goal_mutation_guard_atomic_link_unsupported',
          'Goal state root filesystem must support atomic hard links.',
        )
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  }

  private releaseOperatorRecoveryClaim(owner: GoalMutationOwner): void {
    if (readOwnerAt(this.operatorRecoveryClaimPath)?.nonce !== owner.nonce)
      return
    rmSync(this.operatorRecoveryClaimPath, { force: true })
    syncDirectoryBestEffortSync(dirname(this.operatorRecoveryClaimPath))
  }

  private ownsOperatorRecoveryClaim(owner: GoalMutationOwner): boolean {
    return readOwnerAt(this.operatorRecoveryClaimPath)?.nonce === owner.nonce
  }

  private persistOperatorRecoveryIntent(
    diagnostic: GoalMutationRecoveryMarkerDiagnostic,
    originalIntent: Record<string, unknown>,
    claim: GoalMutationOwner,
  ): Record<string, unknown> {
    const recoveryId = sha256(
      canonicalJson({
        markerSha256: diagnostic.rawMarkerSha256,
        targetRecoveryId: originalIntent.recoveryId,
        originalIntentSha256: diagnostic.intentSha256,
        expectedOwnerSha256: diagnostic.expectedOwnerSha256,
        expectedPathIdentitySha256: diagnostic.expectedPathIdentitySha256,
        expectedNonce: diagnostic.expectedNonce,
      }),
    )
    const path = join(this.recoveryIntentsDir, `operator-${recoveryId}.json`)
    const base = {
      schemaVersion:
        'cairn.goal.mutation-guard-operator-recovery-intent.v1' as const,
      recoveryId,
      targetRecoveryId: originalIntent.recoveryId,
      phase: 'intent_persisted' as const,
      reason: `operator-${diagnostic.status}-marker-recovery`,
      markerSha256: diagnostic.rawMarkerSha256,
      originalIntentSha256: diagnostic.intentSha256,
      expectedOwnerSha256: diagnostic.expectedOwnerSha256,
      expectedPathIdentitySha256: diagnostic.expectedPathIdentitySha256,
      expectedNonce: diagnostic.expectedNonce,
      operatorNonce: claim.nonce,
      persistedAt: new Date().toISOString(),
      recoveredByPid: process.pid,
      recoveredByHostname: hostname(),
    }
    const record = {
      ...base,
      integritySha256: sha256(canonicalJson(base)),
    }
    const published = publishAtomicJsonFile(path, record)
    const persisted = readIntegrityRecord(path)
    if (
      !persisted ||
      persisted.schemaVersion !== base.schemaVersion ||
      persisted.recoveryId !== recoveryId ||
      persisted.targetRecoveryId !== originalIntent.recoveryId ||
      persisted.markerSha256 !== diagnostic.rawMarkerSha256 ||
      persisted.originalIntentSha256 !== diagnostic.intentSha256 ||
      persisted.expectedOwnerSha256 !== diagnostic.expectedOwnerSha256 ||
      persisted.expectedPathIdentitySha256 !==
        diagnostic.expectedPathIdentitySha256 ||
      persisted.expectedNonce !== diagnostic.expectedNonce ||
      (published && canonicalJson(persisted) !== canonicalJson(record))
    )
      throw new GoalMutationGuardError(
        'goal_mutation_guard_operator_recovery_intent_conflict',
        'Goal mutation operator recovery intent conflicts with durable state.',
      )
    return persisted
  }

  private appendOperatorRecoveryCompletion(
    intent: Record<string, unknown>,
  ): void {
    const recoveryId = normalizeSha256(intent.recoveryId)
    if (!recoveryId || !hasCanonicalIntegrity(intent))
      throw new GoalMutationGuardError(
        'goal_mutation_guard_operator_recovery_intent_invalid',
        'Goal mutation operator recovery intent is invalid.',
      )
    repairRecoveryAuditTail(this.recoveryAuditPath)
    if (recoveryAuditContains(this.recoveryAuditPath, recoveryId)) return
    const base = {
      schemaVersion: 'cairn.goal.mutation-guard-operator-recovery.v1' as const,
      recoveryId,
      targetRecoveryId: intent.targetRecoveryId,
      phase: 'completed' as const,
      reason: intent.reason,
      markerSha256: intent.markerSha256,
      originalIntentSha256: intent.originalIntentSha256,
      expectedOwnerSha256: intent.expectedOwnerSha256,
      expectedPathIdentitySha256: intent.expectedPathIdentitySha256,
      expectedNonce: intent.expectedNonce,
      intentIntegritySha256: intent.integritySha256,
      recoveredAt: new Date().toISOString(),
      recoveredByPid: process.pid,
      recoveredByHostname: hostname(),
    }
    const record = {
      ...base,
      integritySha256: sha256(canonicalJson(base)),
    }
    appendIntegrityJsonLine(this.recoveryAuditPath, record)
    if (!recoveryAuditContains(this.recoveryAuditPath, recoveryId))
      throw new GoalMutationGuardError(
        'goal_mutation_guard_operator_recovery_audit_unavailable',
        'Goal mutation operator recovery audit is unavailable.',
      )
  }

  private assertNotLocallyNested(purpose: GoalMutationPurpose): void {
    const active = currentLocalLease(this.stateRoot)
    if (!active) return
    throw new GoalMutationGuardError(
      active.purpose === 'terminal'
        ? 'goal_terminal_validation_active'
        : 'goal_mutation_guard_busy',
      `Goal ${purpose} cannot start while ${active.purpose} owns the state root.`,
    )
  }

  private tryAcquire(purpose: GoalMutationPurpose): GoalMutationOwner | null {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(this.path), 0o700)
    if (existsSync(this.operatorRecoveryClaimPath)) return null
    if (this.clearFinishedRecoveryMarker()) return this.tryAcquire(purpose)
    if (existsSync(this.recoveryMarkerPath)) return null
    if (existsSync(this.operatorRecoveryClaimPath)) return null
    const currentIdentity = currentStableProcessIdentity()
    const owner: GoalMutationOwner = {
      schemaVersion: OWNER_SCHEMA,
      pid: process.pid,
      hostname: hostname(),
      nonce: randomUUID(),
      purpose,
      acquiredAt: new Date().toISOString(),
      bootMarker: currentIdentity.bootMarker,
      processStartIdentity: currentIdentity.processStartIdentity,
    }
    const temporary = `${this.path}.claim-${owner.nonce}`
    try {
      writeFileSync(temporary, JSON.stringify(owner), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      linkSync(temporary, this.path)
      rmSync(temporary, { force: true })
      if (
        existsSync(this.recoveryMarkerPath) ||
        existsSync(this.operatorRecoveryClaimPath)
      ) {
        if (readOwnerAt(this.path)?.nonce === owner.nonce) {
          const aborted = `${this.path}.aborted-${owner.nonce}`
          renameSync(this.path, aborted)
          rmSync(aborted, { force: true })
        }
        return null
      }
      return owner
    } catch (error) {
      rmSync(temporary, { force: true })
      if (isUnsupportedHardlinkError(error))
        throw new GoalMutationGuardError(
          'goal_mutation_guard_atomic_link_unsupported',
          'Goal state root filesystem must support atomic hard links.',
        )
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
      if (this.reclaimDeadStaleOwner()) return this.tryAcquire(purpose)
      // Recovery may have durably removed the stale owner but failed while
      // appending its completion audit. Finish that exact local marker in the
      // same acquisition attempt so time spent fsyncing the intent cannot turn
      // a recoverable state into an unrelated outer timeout.
      return this.clearFinishedRecoveryMarker()
        ? this.tryAcquire(purpose)
        : null
    }
  }

  private reclaimDeadStaleOwner(): boolean {
    let age: number
    try {
      age = Date.now() - statSync(this.path).mtimeMs
    } catch {
      return false
    }
    if (age < this.staleMs) return false
    const diagnostic = this.diagnoseOwner()
    if (
      diagnostic.status !== 'dead' &&
      diagnostic.status !== 'pid_reused' &&
      diagnostic.status !== 'previous_boot'
    )
      return false
    return this.removeOwner(diagnostic, diagnostic.status)
  }

  private removeOwner(
    diagnostic: GoalMutationOwnerDiagnostic,
    reason: string,
  ): boolean {
    if (!diagnostic.ownerSha256 && !diagnostic.pathIdentitySha256) return false
    if (existsSync(this.operatorRecoveryClaimPath)) return false
    const recoveryId = sha256(
      canonicalJson({
        reason,
        ownerSha256: diagnostic.ownerSha256,
        pathIdentitySha256: diagnostic.pathIdentitySha256,
        nonce: diagnostic.nonce,
      }),
    )
    let markerClaimed = false
    let ownerRemoved = false
    try {
      const markerBase = {
        schemaVersion: 'cairn.goal.mutation-guard-recovery-marker.v1',
        recoveryId,
        reason,
        expectedStatus: diagnostic.status,
        expectedNonce: diagnostic.nonce,
        expectedOwnerSha256: diagnostic.ownerSha256,
        expectedPathIdentitySha256: diagnostic.pathIdentitySha256,
        recoveryPid: process.pid,
        recoveryHostname: hostname(),
        recoveryBootMarker: currentStableProcessIdentity().bootMarker,
        recoveryProcessStartIdentity:
          currentStableProcessIdentity().processStartIdentity,
      }
      const marker = {
        ...markerBase,
        integritySha256: sha256(canonicalJson(markerBase)),
      }
      if (!this.claimRecoveryMarker(marker)) return false
      markerClaimed = true
      ACTIVE_RECOVERY_IDS.add(recoveryId)
      const moved = diagnoseOwnerAt(this.path)
      if (
        moved.ownerSha256 !== diagnostic.ownerSha256 ||
        moved.pathIdentitySha256 !== diagnostic.pathIdentitySha256 ||
        moved.nonce !== diagnostic.nonce ||
        moved.status !== diagnostic.status
      )
        throw new GoalMutationGuardError(
          'goal_mutation_guard_owner_changed',
          'Goal mutation owner changed during stale recovery.',
        )
      this.beforeRecoveryAudit?.()
      const intent = this.persistRecoveryIntent(diagnostic, reason, recoveryId)
      rmSync(this.path, { recursive: true, force: false })
      ownerRemoved = true
      syncDirectoryBestEffortSync(dirname(this.path))
      this.beforeRecoveryCompletion?.()
      this.appendRecoveryCompletion(intent)
      rmSync(this.recoveryMarkerPath, { force: false })
      syncDirectoryBestEffortSync(dirname(this.path))
      return true
    } catch (error) {
      if (
        error instanceof GoalMutationGuardError &&
        !ownerRemoved &&
        existsSync(this.recoveryMarkerPath)
      )
        rmSync(this.recoveryMarkerPath, { force: true })
      if (error instanceof GoalMutationGuardError) throw error
      return false
    } finally {
      if (markerClaimed) ACTIVE_RECOVERY_IDS.delete(recoveryId)
    }
  }

  private persistRecoveryIntent(
    diagnostic: GoalMutationOwnerDiagnostic,
    reason: string,
    recoveryId: string,
  ): Record<string, unknown> {
    const base = {
      schemaVersion: 'cairn.goal.mutation-guard-recovery-intent.v1' as const,
      recoveryId,
      phase: 'intent_persisted' as const,
      reason,
      previousStatus: diagnostic.status,
      previousNonce: diagnostic.nonce,
      previousOwnerSha256: diagnostic.ownerSha256,
      previousPathIdentitySha256: diagnostic.pathIdentitySha256,
      persistedAt: new Date().toISOString(),
      recoveredByPid: process.pid,
      recoveredByHostname: hostname(),
    }
    const record = {
      ...base,
      integritySha256: sha256(canonicalJson(base)),
    }
    const path = this.recoveryIntentPath(recoveryId)
    const published = publishAtomicJsonFile(path, record)
    const persisted = readIntegrityRecord(path)
    const matchesRecovery =
      persisted?.schemaVersion ===
        'cairn.goal.mutation-guard-recovery-intent.v1' &&
      persisted.recoveryId === recoveryId &&
      persisted.reason === reason &&
      persisted.previousStatus === diagnostic.status &&
      persisted.previousNonce === diagnostic.nonce &&
      persisted.previousOwnerSha256 === diagnostic.ownerSha256 &&
      persisted.previousPathIdentitySha256 === diagnostic.pathIdentitySha256
    if (!persisted || (!published && !matchesRecovery))
      throw new GoalMutationGuardError(
        'goal_mutation_guard_recovery_intent_conflict',
        'Goal mutation recovery intent conflicts with durable state.',
      )
    if (published && canonicalJson(persisted) !== canonicalJson(record))
      throw new GoalMutationGuardError(
        'goal_mutation_guard_recovery_intent_unavailable',
        'Goal mutation recovery intent is unavailable after persistence.',
      )
    return persisted
  }

  private appendRecoveryCompletion(intent: Record<string, unknown>): void {
    const recoveryId = normalizeSha256(intent.recoveryId)
    if (!recoveryId || !hasCanonicalIntegrity(intent))
      throw new GoalMutationGuardError(
        'goal_mutation_guard_recovery_intent_invalid',
        'Goal mutation recovery intent is invalid.',
      )
    repairRecoveryAuditTail(this.recoveryAuditPath)
    if (recoveryAuditContains(this.recoveryAuditPath, recoveryId)) return
    const base = {
      schemaVersion: 'cairn.goal.mutation-guard-recovery.v1' as const,
      recoveryId,
      phase: 'completed' as const,
      reason: intent.reason,
      previousStatus: intent.previousStatus,
      previousNonce: intent.previousNonce,
      previousOwnerSha256: intent.previousOwnerSha256,
      previousPathIdentitySha256: intent.previousPathIdentitySha256,
      intentIntegritySha256: intent.integritySha256,
      recoveredAt: new Date().toISOString(),
      recoveredByPid: process.pid,
      recoveredByHostname: hostname(),
    }
    const record = {
      ...base,
      integritySha256: sha256(canonicalJson(base)),
    }
    mkdirSync(dirname(this.recoveryAuditPath), {
      recursive: true,
      mode: 0o700,
    })
    const descriptor = openSync(this.recoveryAuditPath, 'a', 0o600)
    try {
      writeAllSync(descriptor, `${JSON.stringify(record)}\n`)
      syncFileBestEffortSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    syncDirectoryBestEffortSync(dirname(this.recoveryAuditPath))
    if (!recoveryAuditContains(this.recoveryAuditPath, recoveryId))
      throw new GoalMutationGuardError(
        'goal_mutation_guard_recovery_audit_unavailable',
        'Goal mutation recovery completion audit is unavailable.',
      )
  }

  private heartbeat(lease: GoalMutationLease): void {
    try {
      if (this.readOwner()?.nonce !== lease.nonce) return
      const now = new Date()
      utimesSync(this.path, now, now)
    } catch {
      // A lost heartbeat makes the owner fail closed; live pid is never reaped.
    }
  }

  private release(lease: GoalMutationLease): void {
    const owner = this.readOwner()
    if (owner?.nonce !== lease.nonce)
      throw new GoalMutationGuardError(
        'goal_mutation_guard_owner_changed',
        'Goal mutation lock ownership changed before release.',
      )
    this.clearFinishedRecoveryMarker()
    if (existsSync(this.recoveryMarkerPath))
      throw new GoalMutationGuardError(
        'goal_mutation_guard_recovery_active',
        'Goal mutation lock recovery is active.',
      )
    const released = `${this.path}.release-${lease.nonce}`
    renameSync(this.path, released)
    rmSync(released, { recursive: true, force: true })
  }

  private readOwner(): GoalMutationOwner | null {
    return readOwnerAt(this.path)
  }

  private clearFinishedRecoveryMarker(): boolean {
    if (!existsSync(this.recoveryMarkerPath)) return false
    let marker: Record<string, unknown>
    try {
      const parsed = JSON.parse(readFileSync(this.recoveryMarkerPath, 'utf8'))
      if (!isRecord(parsed)) return false
      marker = parsed
    } catch {
      return false
    }
    const recoveryId = normalizeSha256(marker.recoveryId)
    if (
      marker.schemaVersion !== 'cairn.goal.mutation-guard-recovery-marker.v1' ||
      !recoveryId ||
      !hasCanonicalIntegrity(marker)
    )
      return false
    const markerOwnerStatus = recoveryMarkerOwnerStatus(marker)
    const locallyFinished =
      marker.recoveryPid === process.pid && !ACTIVE_RECOVERY_IDS.has(recoveryId)
    if (markerOwnerStatus !== 'stale' && !locallyFinished) return false
    const diagnostic = diagnoseOwnerAt(this.path)
    const intent = readIntegrityRecord(this.recoveryIntentPath(recoveryId))
    const hasDurableIntent = Boolean(
      intent &&
      isRecoveryIntentRecord(intent) &&
      recoveryIntentMatchesMarker(intent, marker),
    )
    if (diagnostic.status === 'missing' && !hasDurableIntent) return false
    const pathMatches =
      (diagnostic.status === 'missing' && hasDurableIntent) ||
      (diagnostic.ownerSha256 === marker.expectedOwnerSha256 &&
        diagnostic.pathIdentitySha256 === marker.expectedPathIdentitySha256 &&
        diagnostic.nonce === marker.expectedNonce)
    if (!pathMatches) {
      if (!this.removeExactRecoveryMarker(marker)) return false
      syncDirectoryBestEffortSync(dirname(this.path))
      return true
    }
    if (diagnostic.status === 'missing') this.appendRecoveryCompletion(intent!)
    rmSync(this.recoveryMarkerPath, { force: true })
    syncDirectoryBestEffortSync(dirname(this.path))
    return true
  }

  private claimRecoveryMarker(
    marker: Readonly<Record<string, unknown>>,
  ): boolean {
    return publishAtomicJsonFile(this.recoveryMarkerPath, marker)
  }

  private removeExactRecoveryMarker(
    expected: Readonly<Record<string, unknown>>,
  ): boolean {
    try {
      const value = JSON.parse(
        readFileSync(this.recoveryMarkerPath, 'utf8'),
      ) as unknown
      if (!isRecord(value) || canonicalJson(value) !== canonicalJson(expected))
        return false
      rmSync(this.recoveryMarkerPath, { force: false })
      return true
    } catch {
      return false
    }
  }

  private recoveryIntentPath(recoveryId: string): string {
    return join(this.recoveryIntentsDir, `${recoveryId}.json`)
  }

  private busyError(): GoalMutationGuardError {
    return new GoalMutationGuardError(
      'goal_mutation_guard_busy',
      'Goal state root is owned by another mutation or terminal commit.',
    )
  }
}

interface RecoveryIntentDiagnostic {
  readonly path: string
  readonly rawSha256: string | null
  readonly record: Record<string, unknown> | null
  readonly valid: boolean
}

function diagnoseRecoveryMarkerAt(input: {
  readonly markerPath: string
  readonly ownerPath: string
  readonly intentsDir: string
}): GoalMutationRecoveryMarkerDiagnostic {
  const currentOwner = diagnoseOwnerAt(input.ownerPath)
  if (!existsSync(input.markerPath))
    return recoveryMarkerDiagnostic({
      status: 'missing',
      markerPath: input.markerPath,
      rawMarkerSha256: null,
      recoveryId: null,
      intent: null,
      expectedOwnerSha256: null,
      expectedPathIdentitySha256: null,
      expectedNonce: null,
      currentOwner,
      markerOwnerStatus: null,
    })

  let rawMarker: Buffer
  try {
    rawMarker = readFileSync(input.markerPath)
  } catch {
    return recoveryMarkerDiagnostic({
      status: 'corrupt',
      markerPath: input.markerPath,
      rawMarkerSha256: null,
      recoveryId: null,
      intent: null,
      expectedOwnerSha256: null,
      expectedPathIdentitySha256: null,
      expectedNonce: null,
      currentOwner,
      markerOwnerStatus: null,
    })
  }
  const rawMarkerSha256 = sha256Buffer(rawMarker)
  let parsed: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(rawMarker.toString('utf8')) as unknown
    if (isRecord(value)) parsed = value
  } catch {
    parsed = null
  }
  const recoveryId = parsed ? normalizeSha256(parsed.recoveryId) : null
  let intent = recoveryId
    ? diagnoseRecoveryIntent(
        join(input.intentsDir, `${recoveryId}.json`),
        recoveryId,
      )
    : null
  if (!recoveryId) {
    const candidates = listValidRecoveryIntents(input.intentsDir)
    if (candidates.length === 1) intent = candidates[0]!
  }

  if (parsed === null || !isRecoveryMarkerRecord(parsed)) {
    const proof = intent?.valid ? intent.record : null
    return recoveryMarkerDiagnostic({
      status: 'corrupt',
      markerPath: input.markerPath,
      rawMarkerSha256,
      recoveryId,
      intent,
      expectedOwnerSha256: proof
        ? nullableSha256(proof.previousOwnerSha256)
        : null,
      expectedPathIdentitySha256: proof
        ? nullableSha256(proof.previousPathIdentitySha256)
        : null,
      expectedNonce: proof ? nullableString(proof.previousNonce) : null,
      currentOwner,
      markerOwnerStatus: null,
    })
  }

  const markerOwnerStatus = recoveryMarkerOwnerStatus(parsed)
  const exactIntent =
    intent?.valid === true &&
    intent.record !== null &&
    recoveryIntentMatchesMarker(intent.record, parsed)
      ? intent
      : intent
        ? { ...intent, valid: false }
        : null
  return recoveryMarkerDiagnostic({
    status: markerOwnerStatus,
    markerPath: input.markerPath,
    rawMarkerSha256,
    recoveryId,
    intent: exactIntent,
    expectedOwnerSha256: nullableSha256(parsed.expectedOwnerSha256),
    expectedPathIdentitySha256: nullableSha256(
      parsed.expectedPathIdentitySha256,
    ),
    expectedNonce: nullableString(parsed.expectedNonce),
    currentOwner,
    markerOwnerStatus,
  })
}

function recoveryMarkerDiagnostic(input: {
  readonly status: GoalMutationRecoveryMarkerStatus
  readonly markerPath: string
  readonly rawMarkerSha256: string | null
  readonly recoveryId: string | null
  readonly intent: RecoveryIntentDiagnostic | null
  readonly expectedOwnerSha256: string | null
  readonly expectedPathIdentitySha256: string | null
  readonly expectedNonce: string | null
  readonly currentOwner: GoalMutationOwnerDiagnostic
  readonly markerOwnerStatus: GoalMutationRecoveryMarkerOwnerStatus | null
}): GoalMutationRecoveryMarkerDiagnostic {
  return Object.freeze({
    status: input.status,
    markerPath: input.markerPath,
    rawMarkerSha256: input.rawMarkerSha256,
    recoveryId: input.recoveryId,
    intentPath: input.intent?.path ?? null,
    intentSha256: input.intent?.rawSha256 ?? null,
    intentValid: input.intent?.valid ?? false,
    expectedOwnerSha256: input.expectedOwnerSha256,
    expectedPathIdentitySha256: input.expectedPathIdentitySha256,
    expectedNonce: input.expectedNonce,
    currentOwner: input.currentOwner,
    markerOwnerStatus: input.markerOwnerStatus,
  })
}

function isRecoveryMarkerRecord(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === 'cairn.goal.mutation-guard-recovery-marker.v1' &&
    normalizeSha256(value.recoveryId) !== null &&
    typeof value.reason === 'string' &&
    value.reason.trim().length > 0 &&
    isOwnerStatus(value.expectedStatus) &&
    isNullableString(value.expectedNonce) &&
    isNullableSha256(value.expectedOwnerSha256) &&
    isNullableSha256(value.expectedPathIdentitySha256) &&
    hasCanonicalIntegrity(value)
  )
}

function diagnoseRecoveryIntent(
  path: string,
  expectedRecoveryId?: string,
): RecoveryIntentDiagnostic {
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch {
    return { path, rawSha256: null, record: null, valid: false }
  }
  let record: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown
    if (isRecord(value)) record = value
  } catch {
    record = null
  }
  return {
    path,
    rawSha256: sha256Buffer(raw),
    record,
    valid:
      record !== null &&
      isRecoveryIntentRecord(record) &&
      (expectedRecoveryId === undefined ||
        record.recoveryId === expectedRecoveryId),
  }
}

function listValidRecoveryIntents(
  directory: string,
): RecoveryIntentDiagnostic[] {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  return names
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .sort()
    .map((name) => diagnoseRecoveryIntent(join(directory, name)))
    .filter((candidate) => candidate.valid)
}

function isRecoveryIntentRecord(value: Record<string, unknown>): boolean {
  const recoveryId = normalizeSha256(value.recoveryId)
  return (
    value.schemaVersion === 'cairn.goal.mutation-guard-recovery-intent.v1' &&
    recoveryId !== null &&
    value.phase === 'intent_persisted' &&
    typeof value.reason === 'string' &&
    value.reason.trim().length > 0 &&
    isOwnerStatus(value.previousStatus) &&
    isNullableString(value.previousNonce) &&
    isNullableSha256(value.previousOwnerSha256) &&
    isNullableSha256(value.previousPathIdentitySha256) &&
    (value.previousOwnerSha256 !== null ||
      value.previousPathIdentitySha256 !== null) &&
    hasCanonicalIntegrity(value)
  )
}

function recoveryIntentMatchesMarker(
  intent: Record<string, unknown>,
  marker: Record<string, unknown>,
): boolean {
  return (
    intent.recoveryId === marker.recoveryId &&
    intent.reason === marker.reason &&
    intent.previousStatus === marker.expectedStatus &&
    intent.previousNonce === marker.expectedNonce &&
    intent.previousOwnerSha256 === marker.expectedOwnerSha256 &&
    intent.previousPathIdentitySha256 === marker.expectedPathIdentitySha256
  )
}

function recoveryOwnerMatchesIntent(
  owner: GoalMutationOwnerDiagnostic,
  intent: Record<string, unknown>,
): boolean {
  return (
    owner.status !== 'missing' &&
    owner.status !== 'active' &&
    owner.status === intent.previousStatus &&
    owner.nonce === intent.previousNonce &&
    owner.ownerSha256 === intent.previousOwnerSha256 &&
    owner.pathIdentitySha256 === intent.previousPathIdentitySha256
  )
}

function removeExactRawFile(path: string, expectedSha256: string): boolean {
  try {
    if (sha256Buffer(readFileSync(path)) !== expectedSha256) return false
    rmSync(path, { force: false })
    return true
  } catch {
    return false
  }
}

function appendIntegrityJsonLine(
  path: string,
  record: Record<string, unknown>,
): void {
  if (!hasCanonicalIntegrity(record))
    throw new GoalMutationGuardError(
      'goal_mutation_guard_recovery_audit_invalid',
      'Goal mutation recovery audit record is invalid.',
    )
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const descriptor = openSync(path, 'a', 0o600)
  try {
    writeAllSync(descriptor, `${JSON.stringify(record)}\n`)
    syncFileBestEffortSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  syncDirectoryBestEffortSync(dirname(path))
}

function isOwnerStatus(value: unknown): value is GoalMutationOwnerStatus {
  return (
    value === 'missing' ||
    value === 'active' ||
    value === 'dead' ||
    value === 'pid_reused' ||
    value === 'previous_boot' ||
    value === 'ambiguous' ||
    value === 'corrupt'
  )
}

function isNullableString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0)
}

function nullableString(value: unknown): string | null {
  return isNullableString(value) ? value : null
}

function isNullableSha256(value: unknown): value is string | null {
  return value === null || normalizeSha256(value) !== null
}

function nullableSha256(value: unknown): string | null {
  return value === null ? null : normalizeSha256(value)
}

function readOwnerAt(path: string): GoalMutationOwner | null {
  if (!existsSync(path)) return null
  try {
    return parseOwner(JSON.parse(readFileSync(ownerDocumentPath(path), 'utf8')))
  } catch {
    return null
  }
}

function diagnoseOwnerAt(path: string): GoalMutationOwnerDiagnostic {
  if (!existsSync(path))
    return ownerDiagnostic('missing', path, null, null, null)
  const ownerPath = ownerDocumentPath(path)
  let raw = ''
  try {
    raw = readFileSync(ownerPath, 'utf8')
  } catch {
    return ownerDiagnostic('corrupt', path, null, null, null)
  }
  const ownerSha256 = sha256(raw)
  let value: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed))
      return ownerDiagnostic('corrupt', path, null, null, ownerSha256)
    value = parsed
  } catch {
    return ownerDiagnostic('corrupt', path, null, null, ownerSha256)
  }
  const pid = Number(value.pid)
  const nonce = typeof value.nonce === 'string' ? value.nonce : null
  const acquiredAt =
    typeof value.acquiredAt === 'string' &&
    Number.isFinite(Date.parse(value.acquiredAt))
      ? value.acquiredAt
      : null
  if (
    !Number.isInteger(pid) ||
    pid < 1 ||
    !nonce ||
    !acquiredAt ||
    (value.purpose !== 'mutation' &&
      value.purpose !== 'terminal' &&
      value.purpose !== 'diagnostic')
  )
    return ownerDiagnostic('corrupt', path, nonce, acquiredAt, ownerSha256)
  if (value.hostname !== hostname())
    return ownerDiagnostic('ambiguous', path, nonce, acquiredAt, ownerSha256)
  if (
    value.schemaVersion !== OWNER_SCHEMA &&
    value.schemaVersion !== PREVIOUS_OWNER_SCHEMA
  )
    return ownerDiagnostic('ambiguous', path, nonce, acquiredAt, ownerSha256)
  if (
    typeof value.bootMarker !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.bootMarker)
  )
    return ownerDiagnostic('ambiguous', path, nonce, acquiredAt, ownerSha256)
  const storedIdentity = parseStableProcessStartIdentity(
    value.processStartIdentity,
  )
  if (!storedIdentity)
    return ownerDiagnostic('ambiguous', path, nonce, acquiredAt, ownerSha256)
  const localIdentity = currentStableProcessIdentity()
  const currentBootMarker = localIdentity.bootMarker
  if (!currentBootMarker)
    return ownerDiagnostic('ambiguous', path, nonce, acquiredAt, ownerSha256)
  if (value.bootMarker !== currentBootMarker)
    return ownerDiagnostic(
      'previous_boot',
      path,
      nonce,
      acquiredAt,
      ownerSha256,
    )
  if (!pidIsAlive(pid))
    return ownerDiagnostic('dead', path, nonce, acquiredAt, ownerSha256)
  const currentIdentity =
    pid === process.pid
      ? localIdentity.processStartIdentity
      : stableProcessStartIdentity(pid, currentBootMarker)
  if (!currentIdentity)
    return ownerDiagnostic('ambiguous', path, nonce, acquiredAt, ownerSha256)
  const comparison = compareStableProcessStartIdentity(
    storedIdentity,
    currentIdentity,
  )
  return ownerDiagnostic(
    comparison === 'same'
      ? 'active'
      : comparison === 'different'
        ? 'pid_reused'
        : 'ambiguous',
    path,
    nonce,
    acquiredAt,
    ownerSha256,
  )
}

function parseOwner(value: unknown): GoalMutationOwner | null {
  if (!isRecord(value)) return null
  const identity =
    value.processStartIdentity === null
      ? null
      : parseStableProcessStartIdentity(value.processStartIdentity)
  if (
    (value.schemaVersion !== OWNER_SCHEMA &&
      value.schemaVersion !== PREVIOUS_OWNER_SCHEMA) ||
    !Number.isInteger(value.pid) ||
    Number(value.pid) < 1 ||
    typeof value.hostname !== 'string' ||
    !value.hostname ||
    typeof value.nonce !== 'string' ||
    !value.nonce ||
    (value.purpose !== 'mutation' &&
      value.purpose !== 'terminal' &&
      value.purpose !== 'diagnostic') ||
    typeof value.acquiredAt !== 'string' ||
    !Number.isFinite(Date.parse(value.acquiredAt)) ||
    !(
      value.bootMarker === null ||
      (typeof value.bootMarker === 'string' &&
        /^[a-f0-9]{64}$/.test(value.bootMarker))
    ) ||
    !(value.processStartIdentity === null || identity)
  )
    return null
  return {
    schemaVersion: OWNER_SCHEMA,
    pid: Number(value.pid),
    hostname: value.hostname,
    nonce: value.nonce,
    purpose: value.purpose,
    acquiredAt: value.acquiredAt,
    bootMarker: value.bootMarker,
    processStartIdentity: identity,
  }
}

function ownerDiagnostic(
  status: GoalMutationOwnerStatus,
  path: string,
  nonce: string | null,
  acquiredAt: string | null,
  ownerSha256: string | null,
): GoalMutationOwnerDiagnostic {
  return Object.freeze({
    status,
    path,
    nonce,
    acquiredAt,
    ownerSha256,
    pathIdentitySha256: pathIdentitySha256(path),
  })
}

function isAutomaticallyRecoverableOwner(
  diagnostic: GoalMutationOwnerDiagnostic,
): boolean {
  return (
    diagnostic.status === 'dead' ||
    diagnostic.status === 'pid_reused' ||
    diagnostic.status === 'previous_boot'
  )
}

function sameOwnerDiagnostic(
  current: GoalMutationOwnerDiagnostic,
  expected: GoalMutationOwnerDiagnostic,
): boolean {
  return (
    current.status === expected.status &&
    current.ownerSha256 === expected.ownerSha256 &&
    current.pathIdentitySha256 === expected.pathIdentitySha256 &&
    current.nonce === expected.nonce
  )
}

function ownerDocumentPath(path: string): string {
  try {
    return lstatSync(path).isDirectory() ? join(path, 'owner.json') : path
  } catch {
    return path
  }
}

function pathIdentitySha256(path: string): string | null {
  try {
    const stat = lstatSync(path)
    return sha256(
      canonicalJson({
        kind: stat.isDirectory()
          ? 'directory'
          : stat.isFile()
            ? 'file'
            : 'other',
        device: String(stat.dev),
        inode: String(stat.ino),
        mode: String(stat.mode),
        uid: String(stat.uid),
        gid: String(stat.gid),
        birthtimeMs: String(stat.birthtimeMs),
      }),
    )
  } catch {
    return null
  }
}

function syncFileStrictSync(path: string): void {
  const descriptor = openSync(path, 'r')
  try {
    syncFileBestEffortSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function publishAtomicJsonFile(
  path: string,
  record: Readonly<Record<string, unknown>>,
): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    writeFileSync(temporary, JSON.stringify(record), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    syncFileStrictSync(temporary)
    try {
      linkSync(temporary, path)
      syncDirectoryBestEffortSync(dirname(path))
      return true
    } catch (error) {
      if (isUnsupportedHardlinkError(error))
        throw new GoalMutationGuardError(
          'goal_mutation_guard_atomic_link_unsupported',
          'Goal state root filesystem must support atomic hard links.',
        )
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = readIntegrityRecord(path)
      return (
        existing !== null && canonicalJson(existing) === canonicalJson(record)
      )
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}

function isUnsupportedHardlinkError(error: unknown): boolean {
  const typed = error as NodeJS.ErrnoException
  return (
    typed.syscall === 'link' &&
    (typed.code === 'EPERM' ||
      typed.code === 'ENOTSUP' ||
      typed.code === 'EOPNOTSUPP' ||
      typed.code === 'EXDEV')
  )
}

function readIntegrityRecord(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return isRecord(value) && hasCanonicalIntegrity(value) ? value : null
  } catch {
    return null
  }
}

function writeAllSync(descriptor: number, value: string): void {
  const buffer = Buffer.from(value, 'utf8')
  let offset = 0
  while (offset < buffer.length) {
    const written = writeSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      null,
    )
    if (written < 1)
      throw new GoalMutationGuardError(
        'goal_mutation_guard_recovery_audit_short_write',
        'Goal mutation recovery audit could not be written completely.',
      )
    offset += written
  }
}

function repairRecoveryAuditTail(path: string): void {
  if (!existsSync(path)) return
  const raw = readFileSync(path)
  if (raw.length === 0 || raw[raw.length - 1] === 0x0a) return
  const lastNewline = raw.lastIndexOf(0x0a)
  const trailing = raw.subarray(lastNewline + 1).toString('utf8')
  let trailingComplete = false
  try {
    const value = JSON.parse(trailing) as unknown
    trailingComplete = isRecord(value) && hasCanonicalIntegrity(value)
  } catch {
    trailingComplete = false
  }
  const descriptor = openSync(path, 'r+')
  try {
    if (trailingComplete) {
      const position = raw.length
      const written = writeSync(descriptor, Buffer.from('\n'), 0, 1, position)
      if (written !== 1)
        throw new GoalMutationGuardError(
          'goal_mutation_guard_recovery_audit_short_write',
          'Goal mutation recovery audit terminator could not be written.',
        )
    } else ftruncateSync(descriptor, lastNewline + 1)
    syncFileBestEffortSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  syncDirectoryBestEffortSync(dirname(path))
}

function recoveryAuditContains(path: string, recoveryId: string): boolean {
  if (!existsSync(path)) return false
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .some((line) => {
        if (!line.trim()) return false
        try {
          const value = JSON.parse(line) as unknown
          return (
            isRecord(value) &&
            value.recoveryId === recoveryId &&
            hasCanonicalIntegrity(value)
          )
        } catch {
          return false
        }
      })
  } catch {
    return false
  }
}

function hasCanonicalIntegrity(value: Record<string, unknown>): boolean {
  const integritySha256 = normalizeSha256(value.integritySha256)
  if (!integritySha256) return false
  const base = { ...value }
  delete base.integritySha256
  return sha256(canonicalJson(base)) === integritySha256
}

function recoveryMarkerOwnerStatus(
  marker: Record<string, unknown>,
): GoalMutationRecoveryMarkerOwnerStatus {
  const pid = Number(marker.recoveryPid)
  if (
    !Number.isInteger(pid) ||
    pid < 1 ||
    marker.recoveryHostname !== hostname() ||
    typeof marker.recoveryBootMarker !== 'string' ||
    !/^[a-f0-9]{64}$/.test(marker.recoveryBootMarker)
  )
    return 'ambiguous'
  const storedIdentity = parseStableProcessStartIdentity(
    marker.recoveryProcessStartIdentity,
  )
  if (!storedIdentity) return 'ambiguous'
  const localIdentity = currentStableProcessIdentity()
  if (!localIdentity.bootMarker) return 'ambiguous'
  if (marker.recoveryBootMarker !== localIdentity.bootMarker) return 'stale'
  if (!pidIsAlive(pid)) return 'stale'
  const liveIdentity =
    pid === process.pid
      ? localIdentity.processStartIdentity
      : stableProcessStartIdentity(pid, localIdentity.bootMarker)
  if (!liveIdentity) return 'ambiguous'
  const comparison = compareStableProcessStartIdentity(
    storedIdentity,
    liveIdentity,
  )
  return comparison === 'same'
    ? 'active'
    : comparison === 'different'
      ? 'stale'
      : 'ambiguous'
}

function normalizeSha256(value: unknown): string | null {
  const hash = String(value ?? '').trim()
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const ACTIVE_ASYNC_LEASE = new AsyncLocalStorage<GoalMutationLease>()
const ACTIVE_SYNC_LEASES = new Map<string, GoalMutationLease>()
const ACTIVE_RECOVERY_IDS = new Set<string>()

function currentLocalLease(stateRoot: string): GoalMutationLease | undefined {
  const asynchronous = ACTIVE_ASYNC_LEASE.getStore()
  if (asynchronous?.stateRoot === stateRoot) return asynchronous
  return ACTIVE_SYNC_LEASES.get(stateRoot)
}
