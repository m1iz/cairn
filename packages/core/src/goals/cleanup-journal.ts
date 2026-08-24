import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { canonicalJson } from './events'
import { GoalGateMutationLedger } from './mutation-ledger'
import {
  syncDirectoryBestEffort,
  syncDirectoryBestEffortSync,
  syncFileBestEffortSync,
} from '../util/fs-durability'
import {
  compareStableProcessStartIdentity as compareProcessStartIdentity,
  currentStableProcessIdentity,
  parseStableProcessStartIdentity as parseProcessStartIdentity,
  pidIsAlive,
  stableProcessStartIdentity as processStartIdentity,
} from '../util/stable-process-identity'

const CLEANUP_RECOVERY_SCHEMA = 'cairn.goal.cleanup-claim-recovery' as const
const PREVIOUS_CLEANUP_RECOVERY_SCHEMA =
  'cairn.goal.cleanup-claim-recovery.v2' as const

export type GoalCleanupObligation =
  | 'revoke_plan_tokens'
  | 'clear_active_run'
  | 'clear_pending_interaction'
  | 'emit_runtime_event'

export interface GoalCleanupAcknowledgement {
  readonly schemaVersion: 'cairn.goal.cleanup-ack.v1'
  readonly id: string
  readonly goalId: string
  readonly receiptId: string
  readonly obligation: GoalCleanupObligation
  readonly acknowledgedAt: string
  readonly integritySha256: string
}

export interface GoalCleanupJournalInspection {
  readonly acknowledgements: readonly GoalCleanupAcknowledgement[]
  readonly issue: {
    readonly code: 'goal_cleanup_journal_corrupt'
    readonly path: string
  } | null
}

export interface GoalCleanupClaim {
  readonly path: string
  readonly nonce: string
  readonly receiptId: string
  readonly obligation: GoalCleanupObligation
}

export type GoalCleanupClaimOwnerStatus =
  | 'missing'
  | 'active'
  | 'dead'
  | 'pid_reused'
  | 'previous_boot'
  | 'ambiguous'
  | 'corrupt'

export interface GoalCleanupClaimDiagnostic {
  readonly status: GoalCleanupClaimOwnerStatus
  readonly path: string
  readonly nonce: string | null
  readonly leaseAcquiredAt: string | null
  readonly ownerSha256: string | null
  readonly pathIdentitySha256: string | null
}

/** Structured, opt-in test diagnostics for cross-process claim races. */
export interface GoalCleanupClaimTrace {
  readonly stage:
    | 'attempt'
    | 'directory_created'
    | 'owner_published'
    | 'contended'
    | 'reclaimed'
    | 'blocked'
  readonly pid: number
  readonly receiptId: string
  readonly obligation: GoalCleanupObligation
  readonly path: string
  readonly diagnostic: GoalCleanupClaimDiagnostic
  readonly currentIdentity: ReturnType<typeof currentStableProcessIdentity>
  readonly ownerIdentity: Readonly<Record<string, unknown>> | null
}

/**
 * Append-only acknowledgements for obligations committed in the Goal event.
 * Claims prevent concurrent live execution; they cannot make an external side
 * effect exactly-once across a crash. Recovery is at-least-once and cleanup
 * hosts must deduplicate by receiptId + obligation.
 */
export class GoalCleanupJournal {
  readonly path: string
  readonly claimsDir: string
  readonly ackIntentsDir: string
  private readonly mutations: GoalGateMutationLedger

  constructor(
    readonly stateRoot: string,
    private readonly options: {
      readonly beforeAppend?: (
        acknowledgement: GoalCleanupAcknowledgement,
      ) => void | Promise<void>
      readonly beforeClaimRecoveryRemove?: (
        diagnostic: GoalCleanupClaimDiagnostic,
      ) => void
      readonly afterClaimRecoveryMarkerPublish?: () => void
      readonly onClaimTrace?: (trace: GoalCleanupClaimTrace) => void
      readonly afterAckIntentPersisted?: (context: {
        readonly intentPath: string
        readonly journalPath: string
        readonly record: string
      }) => void
      readonly afterAckJournalDirectorySync?: (context: {
        readonly intentPath: string
        readonly journalPath: string
      }) => void
    } = {},
  ) {
    this.path = join(stateRoot, 'goals', 'post-commit-cleanup-acks.jsonl')
    this.claimsDir = join(stateRoot, 'goals', 'post-commit-cleanup-claims')
    this.ackIntentsDir = join(
      stateRoot,
      'goals',
      'post-commit-cleanup-ack-intents',
    )
    this.mutations = new GoalGateMutationLedger(stateRoot)
  }

  async acknowledge(input: {
    readonly goalId: string
    readonly receiptId: string
    readonly obligation: GoalCleanupObligation
    readonly acknowledgedAt: string
  }): Promise<GoalCleanupAcknowledgement> {
    const base = {
      schemaVersion: 'cairn.goal.cleanup-ack.v1' as const,
      goalId: requiredText(input.goalId),
      receiptId: requiredText(input.receiptId),
      obligation: validObligation(input.obligation),
      acknowledgedAt: requiredTimestamp(input.acknowledgedAt),
    }
    const hash = sha256(canonicalJson(base))
    const acknowledgement = Object.freeze({
      ...base,
      id: `goal_cleanup_ack_${hash.slice(0, 24)}`,
      integritySha256: hash,
    })
    return await this.mutations.withMutation(
      'cleanup',
      `${base.receiptId}:${base.obligation}`,
      async () => {
        const inspected = await this.inspectUnlocked()
        if (inspected.issue) throw new Error('Goal cleanup journal is corrupt.')
        const existing = inspected.acknowledgements.find(
          (item) =>
            item.receiptId === base.receiptId &&
            item.obligation === base.obligation,
        )
        if (existing) return existing
        await this.options.beforeAppend?.(acknowledgement)
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        const record = `${JSON.stringify(acknowledgement)}\n`
        const before = existsSync(this.path)
          ? readFileSync(this.path)
          : Buffer.alloc(0)
        const intentBase = {
          schemaVersion: 'cairn.goal.cleanup-ack-intent.v1' as const,
          receiptId: acknowledgement.receiptId,
          obligation: acknowledgement.obligation,
          expectedSize: before.length,
          expectedPrefixSha256: sha256Buffer(before),
          record,
          canonicalRecord: canonicalJson(acknowledgement),
          recordSha256: sha256(record),
          expectedFinalSize: before.length + Buffer.byteLength(record),
        }
        const intent = {
          ...intentBase,
          integritySha256: sha256(canonicalJson(intentBase)),
        }
        const intentPath = this.ackIntentPath(
          acknowledgement.receiptId,
          acknowledgement.obligation,
        )
        if (!publishAtomicJsonFile(intentPath, intent))
          throw new Error('Goal cleanup acknowledgement intent conflicts.')
        this.options.afterAckIntentPersisted?.({
          intentPath,
          journalPath: this.path,
          record,
        })
        const descriptor = openSync(this.path, 'a', 0o600)
        try {
          writeAllSync(descriptor, record)
          syncFileBestEffortSync(descriptor)
        } finally {
          closeSync(descriptor)
        }
        const persisted = readFileSync(this.path)
        if (
          persisted.length !== intent.expectedFinalSize ||
          sha256Buffer(persisted.subarray(0, intent.expectedSize)) !==
            intent.expectedPrefixSha256 ||
          persisted.subarray(intent.expectedSize).toString('utf8') !== record
        )
          throw new Error('Goal cleanup acknowledgement readback failed.')
        await syncDirectoryBestEffort(dirname(this.path))
        this.options.afterAckJournalDirectorySync?.({
          intentPath,
          journalPath: this.path,
        })
        rmSync(intentPath, { force: false })
        syncDirectoryBestEffortSync(this.ackIntentsDir)
        return acknowledgement
      },
    )
  }

  private ackIntentPath(
    receiptId: string,
    obligation: GoalCleanupObligation,
  ): string {
    return join(
      this.ackIntentsDir,
      `${sha256(`${receiptId}:${obligation}`)}.json`,
    )
  }

  async claim(input: {
    readonly receiptId: string
    readonly obligation: GoalCleanupObligation
  }): Promise<GoalCleanupClaim | null> {
    const receiptId = requiredText(input.receiptId)
    const obligation = validObligation(input.obligation)
    const key = sha256(`${receiptId}:${obligation}`)
    const path = join(this.claimsDir, key)
    mkdirSync(this.claimsDir, { recursive: true, mode: 0o700 })
    const nonce = randomUUID()
    const currentIdentity = currentStableProcessIdentity()
    this.traceClaim('attempt', path, receiptId, obligation)
    if (resumeStaleCleanupRecovery(path, this.claimsDir))
      return await this.claim(input)
    if (existsSync(cleanupRecoveryMarkerPath(path))) {
      this.traceClaim('blocked', path, receiptId, obligation)
      return null
    }
    const owner = {
      schemaVersion: 'cairn.goal.cleanup-claim.v4',
      pid: process.pid,
      hostname: hostname(),
      bootMarker: currentIdentity.bootMarker,
      processStartIdentity: currentIdentity.processStartIdentity,
      leaseAcquiredAt: new Date().toISOString(),
      nonce,
      receiptId,
      obligation,
    }
    const temporary = join(this.claimsDir, `.${key}.claim-${nonce}.tmp`)
    try {
      writeFileSync(temporary, JSON.stringify(owner), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      syncFile(temporary)
      linkSync(temporary, path)
      syncDirectoryBestEffortSync(this.claimsDir)
    } catch (error) {
      rmSync(temporary, { force: true })
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
      this.traceClaim('contended', path, receiptId, obligation)
      if (
        reclaimSafeClaim(
          path,
          this.claimsDir,
          this.options.beforeClaimRecoveryRemove,
          this.options.afterClaimRecoveryMarkerPublish,
        )
      ) {
        this.traceClaim('reclaimed', path, receiptId, obligation)
        return await this.claim(input)
      }
      this.traceClaim('blocked', path, receiptId, obligation)
      return null
    } finally {
      rmSync(temporary, { force: true })
    }
    if (existsSync(cleanupRecoveryMarkerPath(path))) {
      const published = diagnoseClaimOwner(path)
      if (published.nonce === nonce) {
        const aborted = `${path}.aborted-${nonce}`
        renameSync(path, aborted)
        rmSync(aborted, { force: true })
        syncDirectoryBestEffortSync(this.claimsDir)
      }
      this.traceClaim('blocked', path, receiptId, obligation)
      return null
    }
    this.traceClaim('owner_published', path, receiptId, obligation)
    return Object.freeze({ path, nonce, receiptId, obligation })
  }

  private traceClaim(
    stage: GoalCleanupClaimTrace['stage'],
    path: string,
    receiptId: string,
    obligation: GoalCleanupObligation,
  ): void {
    if (!this.options.onClaimTrace) return
    let ownerIdentity: Readonly<Record<string, unknown>> | null = null
    try {
      const parsed = JSON.parse(readFileSync(ownerDocumentPath(path), 'utf8'))
      if (isRecord(parsed))
        ownerIdentity = Object.freeze({
          pid: parsed.pid,
          hostname: parsed.hostname,
          bootMarker: parsed.bootMarker,
          processStartIdentity: parsed.processStartIdentity,
          nonce: parsed.nonce,
        })
    } catch {
      ownerIdentity = null
    }
    try {
      this.options.onClaimTrace(
        Object.freeze({
          stage,
          pid: process.pid,
          receiptId,
          obligation,
          path,
          diagnostic: diagnoseClaimOwner(path),
          currentIdentity: currentStableProcessIdentity(),
          ownerIdentity,
        }),
      )
    } catch {
      // Test diagnostics must never affect claim semantics.
    }
  }

  async releaseClaim(claim: GoalCleanupClaim): Promise<void> {
    const ownerPath = ownerDocumentPath(claim.path)
    let owner: unknown
    try {
      owner = JSON.parse(readFileSync(ownerPath, 'utf8'))
    } catch {
      throw new Error('Goal cleanup claim ownership is unavailable.')
    }
    if (!isRecord(owner) || owner.nonce !== claim.nonce)
      throw new Error('Goal cleanup claim ownership changed.')
    clearMismatchedCleanupRecoveryMarker(claim.path)
    if (existsSync(cleanupRecoveryMarkerPath(claim.path)))
      throw new Error('Goal cleanup claim recovery is active.')
    const released = `${claim.path}.release-${claim.nonce}`
    try {
      renameSync(claim.path, released)
    } catch (cause) {
      const current = JSON.parse(readFileSync(ownerPath, 'utf8')) as unknown
      if (!isRecord(current) || current.nonce !== claim.nonce) throw cause
      rmSync(claim.path, { recursive: true, force: true })
      if (existsSync(claim.path)) throw cause
      syncDirectoryBestEffortSync(this.claimsDir)
      return
    }
    rmSync(released, { recursive: true, force: true })
    if (existsSync(released))
      throw new Error('Goal cleanup claim release is incomplete.')
    syncDirectoryBestEffortSync(this.claimsDir)
  }

  diagnoseClaim(input: {
    readonly receiptId: string
    readonly obligation: GoalCleanupObligation
  }): GoalCleanupClaimDiagnostic {
    return diagnoseClaimOwner(this.claimPath(input))
  }

  /**
   * Explicit operator recovery for legacy/ambiguous owners. The exact nonce
   * and an affirmative stale-owner confirmation are required; active owners
   * are never removed by this API.
   */
  recoverAmbiguousClaim(input: {
    readonly receiptId: string
    readonly obligation: GoalCleanupObligation
    readonly expectedNonce: string
    readonly confirmedOwnerStale: true
  }): boolean {
    const path = this.claimPath(input)
    const diagnostic = diagnoseClaimOwner(path)
    if (
      diagnostic.status !== 'ambiguous' ||
      diagnostic.nonce !== requiredText(input.expectedNonce) ||
      input.confirmedOwnerStale !== true
    )
      return false
    return removeClaim(
      path,
      this.claimsDir,
      'operator-recovery',
      diagnostic,
      this.options.beforeClaimRecoveryRemove,
      this.options.afterClaimRecoveryMarkerPublish,
    )
  }

  /** Explicit operator recovery for an unreadable claim owner document. */
  recoverCorruptClaim(input: {
    readonly receiptId: string
    readonly obligation: GoalCleanupObligation
    readonly expectedPathIdentitySha256: string
    readonly confirmedCorrupt: true
  }): boolean {
    const path = this.claimPath(input)
    const diagnostic = diagnoseClaimOwner(path)
    if (
      input.confirmedCorrupt !== true ||
      diagnostic.status !== 'corrupt' ||
      diagnostic.pathIdentitySha256 !==
        normalizeSha256(input.expectedPathIdentitySha256)
    )
      return false
    return removeClaim(
      path,
      this.claimsDir,
      'operator-corrupt-recovery',
      diagnostic,
      this.options.beforeClaimRecoveryRemove,
      this.options.afterClaimRecoveryMarkerPublish,
    )
  }

  private claimPath(input: {
    readonly receiptId: string
    readonly obligation: GoalCleanupObligation
  }): string {
    const receiptId = requiredText(input.receiptId)
    const obligation = validObligation(input.obligation)
    return join(this.claimsDir, sha256(`${receiptId}:${obligation}`))
  }

  async inspect(): Promise<GoalCleanupJournalInspection> {
    return await this.mutations.guard.runExclusive(
      'diagnostic',
      async () => await this.inspectUnlocked(),
    )
  }

  private async inspectUnlocked(): Promise<GoalCleanupJournalInspection> {
    if (!repairCleanupAckIntent(this.path, this.ackIntentsDir))
      return {
        acknowledgements: [],
        issue: { code: 'goal_cleanup_journal_corrupt', path: this.path },
      }
    if (!existsSync(this.path)) return { acknowledgements: [], issue: null }
    try {
      const raw = await readFile(this.path, 'utf8')
      const acknowledgements: GoalCleanupAcknowledgement[] = []
      const keys = new Set<string>()
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        const acknowledgement = parseAcknowledgement(JSON.parse(line))
        const key = `${acknowledgement.receiptId}:${acknowledgement.obligation}`
        if (keys.has(key)) throw new Error('duplicate cleanup acknowledgement')
        keys.add(key)
        acknowledgements.push(acknowledgement)
      }
      return { acknowledgements, issue: null }
    } catch {
      return {
        acknowledgements: [],
        issue: { code: 'goal_cleanup_journal_corrupt', path: this.path },
      }
    }
  }
}

function syncFile(path: string): void {
  const handle = openSync(path, 'r')
  try {
    syncFileBestEffortSync(handle)
  } finally {
    closeSync(handle)
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
    syncFile(temporary)
    try {
      linkSync(temporary, path)
      syncDirectoryBestEffortSync(dirname(path))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = readIntegrityRecord(path)
      return Boolean(
        existing && canonicalJson(existing) === canonicalJson(record),
      )
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}

function readIntegrityRecord(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return isRecord(value) && hasCleanupMarkerIntegrity(value) ? value : null
  } catch {
    return null
  }
}

function repairCleanupAckIntent(path: string, intentsDir: string): boolean {
  if (!existsSync(intentsDir)) return true
  let intentPaths: string[]
  try {
    intentPaths = readdirSync(intentsDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(intentsDir, name))
  } catch {
    return false
  }
  for (const intentPath of intentPaths) {
    const intent = readIntegrityRecord(intentPath)
    if (
      intent?.schemaVersion !== 'cairn.goal.cleanup-ack-intent.v1' ||
      !Number.isSafeInteger(intent.expectedSize) ||
      Number(intent.expectedSize) < 0 ||
      normalizeSha256(intent.expectedPrefixSha256) === null ||
      typeof intent.record !== 'string' ||
      !intent.record.endsWith('\n') ||
      sha256(intent.record) !== intent.recordSha256 ||
      typeof intent.canonicalRecord !== 'string' ||
      Number(intent.expectedFinalSize) !==
        Number(intent.expectedSize) + Buffer.byteLength(intent.record)
    )
      return false
    try {
      const parsed = JSON.parse(intent.record.slice(0, -1)) as unknown
      parseAcknowledgement(parsed)
      if (canonicalJson(parsed as never) !== intent.canonicalRecord)
        return false
    } catch {
      return false
    }
    const expectedSize = Number(intent.expectedSize)
    const raw = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
    if (
      raw.length < expectedSize ||
      sha256Buffer(raw.subarray(0, expectedSize)) !==
        intent.expectedPrefixSha256
    )
      return false
    const record = Buffer.from(intent.record, 'utf8')
    const tail = raw.subarray(expectedSize)
    if (
      tail.length > record.length ||
      !record.subarray(0, tail.length).equals(tail)
    )
      return false
    if (tail.length !== record.length) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const descriptor = openSync(path, existsSync(path) ? 'r+' : 'w+', 0o600)
      try {
        ftruncateSync(descriptor, expectedSize)
        writeAllSync(descriptor, intent.record, expectedSize)
        syncFileBestEffortSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      syncDirectoryBestEffortSync(dirname(path))
    }
    const repaired = readFileSync(path)
    if (
      repaired.length !== Number(intent.expectedFinalSize) ||
      sha256Buffer(repaired.subarray(0, expectedSize)) !==
        intent.expectedPrefixSha256 ||
      !repaired.subarray(expectedSize).equals(record)
    )
      return false
    rmSync(intentPath, { force: false })
    syncDirectoryBestEffortSync(intentsDir)
  }
  return true
}

function writeAllSync(
  descriptor: number,
  value: string,
  position: number | null = null,
): void {
  const buffer = Buffer.from(value, 'utf8')
  let offset = 0
  while (offset < buffer.length) {
    const written = writeSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      position === null ? null : position + offset,
    )
    if (written < 1) throw new Error('Goal cleanup journal short write.')
    offset += written
  }
}

function reclaimSafeClaim(
  path: string,
  claimsDir: string,
  beforeRemove?: (diagnostic: GoalCleanupClaimDiagnostic) => void,
  afterMarkerPublish?: () => void,
): boolean {
  if (resumeStaleCleanupRecovery(path, claimsDir)) return true
  const diagnostic = diagnoseClaimOwner(path)
  return diagnostic.status === 'dead' ||
    diagnostic.status === 'pid_reused' ||
    diagnostic.status === 'previous_boot'
    ? removeClaim(
        path,
        claimsDir,
        diagnostic.status,
        diagnostic,
        beforeRemove,
        afterMarkerPublish,
      )
    : false
}

function diagnoseClaimOwner(path: string): GoalCleanupClaimDiagnostic {
  let raw: string
  try {
    raw = readFileSync(ownerDocumentPath(path), 'utf8')
  } catch {
    return existsSync(path)
      ? claimDiagnostic('corrupt', path, null, null, null)
      : claimDiagnostic('missing', path, null, null, null)
  }
  const ownerSha256 = sha256(raw)
  let owner: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed))
      return claimDiagnostic('corrupt', path, null, null, ownerSha256)
    owner = parsed
  } catch {
    return claimDiagnostic('corrupt', path, null, null, ownerSha256)
  }
  const pid = Number(owner.pid)
  const nonce = typeof owner.nonce === 'string' ? owner.nonce : null
  const leaseAcquiredAt =
    typeof owner.leaseAcquiredAt === 'string' &&
    Number.isFinite(Date.parse(owner.leaseAcquiredAt))
      ? owner.leaseAcquiredAt
      : null
  if (!Number.isInteger(pid) || pid < 1 || !nonce)
    return claimDiagnostic('corrupt', path, nonce, leaseAcquiredAt, ownerSha256)
  if (owner.hostname !== hostname())
    return claimDiagnostic(
      'ambiguous',
      path,
      nonce,
      leaseAcquiredAt,
      ownerSha256,
    )
  const pathKind = cleanupClaimPathKind(path)
  const compatibleSchema =
    (owner.schemaVersion === 'cairn.goal.cleanup-claim.v4' &&
      pathKind === 'file') ||
    (owner.schemaVersion === 'cairn.goal.cleanup-claim.v3' &&
      pathKind === 'directory')
  if (!compatibleSchema)
    return claimDiagnostic(
      'ambiguous',
      path,
      nonce,
      leaseAcquiredAt,
      ownerSha256,
    )
  if (
    typeof owner.bootMarker !== 'string' ||
    !/^[a-f0-9]{64}$/.test(owner.bootMarker) ||
    !leaseAcquiredAt
  )
    return claimDiagnostic(
      'ambiguous',
      path,
      nonce,
      leaseAcquiredAt,
      ownerSha256,
    )
  const storedIdentity = parseProcessStartIdentity(owner.processStartIdentity)
  if (!storedIdentity)
    return claimDiagnostic(
      'ambiguous',
      path,
      nonce,
      leaseAcquiredAt,
      ownerSha256,
    )
  const localIdentity = currentStableProcessIdentity()
  const currentBootMarker = localIdentity.bootMarker
  if (!currentBootMarker)
    return claimDiagnostic(
      'ambiguous',
      path,
      nonce,
      leaseAcquiredAt,
      ownerSha256,
    )
  if (owner.bootMarker !== currentBootMarker)
    return claimDiagnostic(
      'previous_boot',
      path,
      nonce,
      leaseAcquiredAt,
      ownerSha256,
    )
  if (!pidIsAlive(pid))
    return claimDiagnostic('dead', path, nonce, leaseAcquiredAt, ownerSha256)
  const currentIdentity =
    pid === process.pid
      ? localIdentity.processStartIdentity
      : processStartIdentity(pid, currentBootMarker)
  if (!currentIdentity)
    return claimDiagnostic(
      'ambiguous',
      path,
      nonce,
      leaseAcquiredAt,
      ownerSha256,
    )
  const comparison = compareProcessStartIdentity(
    storedIdentity,
    currentIdentity,
  )
  return claimDiagnostic(
    comparison === 'same'
      ? 'active'
      : comparison === 'different'
        ? 'pid_reused'
        : 'ambiguous',
    path,
    nonce,
    leaseAcquiredAt,
    ownerSha256,
  )
}

function claimDiagnostic(
  status: GoalCleanupClaimOwnerStatus,
  path: string,
  nonce: string | null,
  leaseAcquiredAt: string | null,
  ownerSha256: string | null,
): GoalCleanupClaimDiagnostic {
  return Object.freeze({
    status,
    path,
    nonce,
    leaseAcquiredAt,
    ownerSha256,
    pathIdentitySha256: cleanupClaimPathIdentitySha256(path),
  })
}

function cleanupClaimPathIdentitySha256(path: string): string | null {
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

function cleanupClaimPathKind(
  path: string,
): 'file' | 'directory' | 'other' | 'missing' {
  try {
    const stat = lstatSync(path)
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other'
  } catch {
    return 'missing'
  }
}

function ownerDocumentPath(path: string): string {
  return cleanupClaimPathKind(path) === 'directory'
    ? join(path, 'owner.json')
    : path
}

function cleanupRecoveryMarkerPath(path: string): string {
  return `${path}.recovery`
}

function cleanupClaimMatches(
  actual: GoalCleanupClaimDiagnostic,
  expected: GoalCleanupClaimDiagnostic,
): boolean {
  return (
    actual.status === expected.status &&
    actual.nonce === expected.nonce &&
    actual.ownerSha256 === expected.ownerSha256 &&
    actual.pathIdentitySha256 === expected.pathIdentitySha256
  )
}

function publishCleanupRecoveryMarker(
  markerPath: string,
  marker: Readonly<Record<string, unknown>>,
): boolean {
  return publishAtomicJsonFile(markerPath, marker)
}

function removeOwnedCleanupMarker(
  markerPath: string,
  expected: Readonly<Record<string, unknown>>,
): void {
  try {
    const value = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown
    if (isRecord(value) && canonicalJson(value) === canonicalJson(expected))
      rmSync(markerPath, { force: true })
  } catch {
    // An unreadable or replaced marker stays fail-closed.
  }
}

function resumeStaleCleanupRecovery(path: string, claimsDir: string): boolean {
  const markerPath = cleanupRecoveryMarkerPath(path)
  let marker: Record<string, unknown>
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown
    if (!isRecord(parsed) || !hasCleanupMarkerIntegrity(parsed)) return false
    marker = parsed
  } catch {
    return resumeLegacyCleanupRecovery(path, claimsDir)
  }
  if (
    marker.schemaVersion !== CLEANUP_RECOVERY_SCHEMA &&
    marker.schemaVersion !== PREVIOUS_CLEANUP_RECOVERY_SCHEMA
  )
    return resumeLegacyCleanupRecovery(path, claimsDir)
  const recoveryId = normalizeSha256(marker.recoveryId)
  if (!recoveryId) return false
  const locallyFinished =
    marker.recoveryPid === process.pid &&
    !ACTIVE_CLEANUP_RECOVERY_IDS.has(recoveryId)
  if (cleanupRecoveryMarkerOwnerStatus(marker) !== 'stale' && !locallyFinished)
    return false
  const current = diagnoseClaimOwner(path)
  const expectedPathIdentity = normalizeSha256(
    marker.expectedPathIdentitySha256,
  )
  const ownerMatches =
    current.status === marker.expectedStatus &&
    current.nonce === marker.expectedNonce &&
    current.ownerSha256 === marker.expectedOwnerSha256 &&
    current.pathIdentitySha256 === expectedPathIdentity
  const ownerWasRemoved =
    current.status === 'missing' && current.pathIdentitySha256 === null
  if (!ownerMatches && !ownerWasRemoved) {
    removeOwnedCleanupMarker(markerPath, marker)
    return true
  }
  const intentPath = cleanupRecoveryIntentPath(path, recoveryId)
  const intent = readIntegrityRecord(intentPath)
  if (
    intent?.schemaVersion !== 'cairn.goal.cleanup-claim-recovery-intent.v1' ||
    intent.recoveryId !== recoveryId ||
    intent.expectedOwnerSha256 !== marker.expectedOwnerSha256 ||
    intent.expectedPathIdentitySha256 !== marker.expectedPathIdentitySha256 ||
    intent.expectedNonce !== marker.expectedNonce
  ) {
    // A crash after publishing the recovery marker but before publishing its
    // intent cannot have removed the exact owner yet. Drop only the exact
    // stale marker so the unchanged owner can be reclaimed from scratch.
    if (ownerMatches && !existsSync(intentPath)) {
      removeOwnedCleanupMarker(markerPath, marker)
      if (existsSync(markerPath)) return false
      syncDirectoryBestEffortSync(claimsDir)
      return true
    }
    return false
  }
  try {
    if (ownerMatches) {
      rmSync(path, { recursive: true, force: false })
      syncDirectoryBestEffortSync(claimsDir)
    }
    removeOwnedCleanupMarker(markerPath, marker)
    if (existsSync(markerPath)) return false
    syncDirectoryBestEffortSync(claimsDir)
    rmSync(intentPath, { force: true })
    syncDirectoryBestEffortSync(claimsDir)
    return true
  } catch {
    return false
  }
}

function clearMismatchedCleanupRecoveryMarker(path: string): void {
  const markerPath = cleanupRecoveryMarkerPath(path)
  try {
    const value = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown
    if (!isRecord(value) || !hasCleanupMarkerIntegrity(value)) return
    if (
      normalizeSha256(value.expectedPathIdentitySha256) !==
      cleanupClaimPathIdentitySha256(path)
    )
      removeOwnedCleanupMarker(markerPath, value)
  } catch {
    // Missing, unreadable, or matching markers remain fail-closed.
  }
}

function hasCleanupMarkerIntegrity(value: Record<string, unknown>): boolean {
  const integritySha256 = normalizeSha256(value.integritySha256)
  if (!integritySha256) return false
  const base = { ...value }
  delete base.integritySha256
  return sha256(canonicalJson(base)) === integritySha256
}

function cleanupRecoveryMarkerOwnerStatus(
  marker: Record<string, unknown>,
): 'active' | 'stale' | 'ambiguous' {
  const pid = Number(marker.recoveryPid)
  if (
    !Number.isInteger(pid) ||
    pid < 1 ||
    marker.recoveryHostname !== hostname() ||
    typeof marker.recoveryBootMarker !== 'string' ||
    !/^[a-f0-9]{64}$/.test(marker.recoveryBootMarker)
  )
    return 'ambiguous'
  const storedIdentity = parseProcessStartIdentity(
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
      : processStartIdentity(pid, localIdentity.bootMarker)
  if (!liveIdentity) return 'ambiguous'
  const comparison = compareProcessStartIdentity(storedIdentity, liveIdentity)
  return comparison === 'same'
    ? 'active'
    : comparison === 'different'
      ? 'stale'
      : 'ambiguous'
}

function removeClaim(
  path: string,
  claimsDir: string,
  label: string,
  expected: GoalCleanupClaimDiagnostic,
  beforeRemove?: (diagnostic: GoalCleanupClaimDiagnostic) => void,
  afterMarkerPublish?: () => void,
): boolean {
  const markerPath = cleanupRecoveryMarkerPath(path)
  const recoveryId = sha256(
    canonicalJson({
      label,
      status: expected.status,
      nonce: expected.nonce,
      ownerSha256: expected.ownerSha256,
      pathIdentitySha256: expected.pathIdentitySha256,
    }),
  )
  const markerBase = {
    schemaVersion: CLEANUP_RECOVERY_SCHEMA,
    recoveryId,
    recoveryNonce: randomUUID(),
    label,
    expectedStatus: expected.status,
    expectedNonce: expected.nonce,
    expectedOwnerSha256: expected.ownerSha256,
    expectedPathIdentitySha256: expected.pathIdentitySha256,
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
  let markerClaimed = false
  try {
    if (!publishCleanupRecoveryMarker(markerPath, marker)) return false
    markerClaimed = true
    ACTIVE_CLEANUP_RECOVERY_IDS.add(recoveryId)
    afterMarkerPublish?.()
    const current = diagnoseClaimOwner(path)
    if (!cleanupClaimMatches(current, expected)) {
      removeOwnedCleanupMarker(markerPath, marker)
      return false
    }
    const intentBase = {
      schemaVersion: 'cairn.goal.cleanup-claim-recovery-intent.v1',
      recoveryId,
      label,
      expectedStatus: expected.status,
      expectedNonce: expected.nonce,
      expectedOwnerSha256: expected.ownerSha256,
      expectedPathIdentitySha256: expected.pathIdentitySha256,
    }
    const intent = {
      ...intentBase,
      integritySha256: sha256(canonicalJson(intentBase)),
    }
    if (
      !publishAtomicJsonFile(
        cleanupRecoveryIntentPath(path, recoveryId),
        intent,
      )
    )
      return false
    beforeRemove?.(current)
    if (!cleanupClaimMatches(diagnoseClaimOwner(path), expected)) {
      removeOwnedCleanupMarker(markerPath, marker)
      return false
    }
    rmSync(path, { recursive: true, force: false })
    syncDirectoryBestEffortSync(claimsDir)
    removeOwnedCleanupMarker(markerPath, marker)
    if (existsSync(markerPath)) return false
    syncDirectoryBestEffortSync(claimsDir)
    rmSync(cleanupRecoveryIntentPath(path, recoveryId), { force: true })
    syncDirectoryBestEffortSync(claimsDir)
    return true
  } catch {
    return false
  } finally {
    if (markerClaimed) ACTIVE_CLEANUP_RECOVERY_IDS.delete(recoveryId)
  }
}

function cleanupRecoveryIntentPath(path: string, recoveryId: string): string {
  return `${path}.recovery-intent-${recoveryId}`
}

/** Read-only compatibility for a v3 directory recovery left by an older build. */
function resumeLegacyCleanupRecovery(path: string, claimsDir: string): boolean {
  if (cleanupClaimPathKind(path) !== 'directory') return false
  const markerPath = join(path, '.recovery')
  let marker: Record<string, unknown>
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown
    if (!isRecord(parsed) || !hasCleanupMarkerIntegrity(parsed)) return false
    marker = parsed
  } catch {
    return false
  }
  if (
    marker.schemaVersion !== 'cairn.goal.cleanup-claim-recovery.v1' ||
    cleanupRecoveryMarkerOwnerStatus(marker) !== 'stale'
  )
    return false
  const current = diagnoseClaimOwner(path)
  const ownerMatches =
    current.status === marker.expectedStatus &&
    current.nonce === marker.expectedNonce &&
    current.ownerSha256 === marker.expectedOwnerSha256 &&
    current.pathIdentitySha256 === marker.expectedPathIdentitySha256
  const ownerWasRemoved =
    current.status === 'corrupt' &&
    current.ownerSha256 === null &&
    current.pathIdentitySha256 === marker.expectedPathIdentitySha256
  if (!ownerMatches && !ownerWasRemoved) return false
  try {
    if (ownerMatches) rmSync(ownerDocumentPath(path), { force: true })
    removeOwnedCleanupMarker(markerPath, marker)
    if (existsSync(markerPath)) return false
    rmdirSync(path)
    syncDirectoryBestEffortSync(claimsDir)
    return true
  } catch {
    return false
  }
}

function parseAcknowledgement(value: unknown): GoalCleanupAcknowledgement {
  if (!isRecord(value)) throw new Error('invalid cleanup acknowledgement')
  const base = {
    schemaVersion:
      value.schemaVersion === 'cairn.goal.cleanup-ack.v1'
        ? ('cairn.goal.cleanup-ack.v1' as const)
        : fail(),
    goalId: requiredText(value.goalId),
    receiptId: requiredText(value.receiptId),
    obligation: validObligation(value.obligation),
    acknowledgedAt: requiredTimestamp(value.acknowledgedAt),
  }
  const hash = sha256(canonicalJson(base))
  if (
    value.id !== `goal_cleanup_ack_${hash.slice(0, 24)}` ||
    value.integritySha256 !== hash
  )
    throw new Error('invalid cleanup acknowledgement integrity')
  return Object.freeze({
    ...base,
    id: String(value.id),
    integritySha256: String(value.integritySha256),
  })
}

function validObligation(value: unknown): GoalCleanupObligation {
  if (
    value === 'revoke_plan_tokens' ||
    value === 'clear_active_run' ||
    value === 'clear_pending_interaction' ||
    value === 'emit_runtime_event'
  )
    return value
  return fail()
}

function requiredText(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) throw new Error('invalid cleanup acknowledgement')
  return text
}

function requiredTimestamp(value: unknown): string {
  const timestamp = String(value ?? '')
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error('invalid cleanup acknowledgement')
  return timestamp
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeSha256(value: unknown): string | null {
  const hash = String(value ?? '').trim()
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const ACTIVE_CLEANUP_RECOVERY_IDS = new Set<string>()

function fail(): never {
  throw new Error('invalid cleanup acknowledgement')
}
