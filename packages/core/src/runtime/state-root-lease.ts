import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { CairnError } from '../errors'
import {
  compareStableProcessStartIdentity,
  currentStableProcessIdentity,
  parseStableProcessStartIdentity,
  pidIsAlive,
  stableProcessStartIdentity,
  type StableProcessStartIdentity,
} from '../util/stable-process-identity'

const OWNER_SCHEMA = 'cairn.state-root-lease.v1' as const
const RECOVERY_SCHEMA = 'cairn.state-root-lease-recovery.v1' as const
const LEASE_FILE = '.state-root.lease'
const RECOVERY_FILE = '.state-root.lease.recovery'

export type StateRootHostKind = 'core' | 'desktop' | 'acp'

interface LeaseOwner {
  readonly schemaVersion: typeof OWNER_SCHEMA
  readonly nonce: string
  readonly hostKind: StateRootHostKind
  readonly pid: number
  readonly hostname: string
  readonly acquiredAt: string
  readonly bootMarker: string | null
  readonly processStartIdentity: StableProcessStartIdentity | null
}

interface RecoveryOwner extends Omit<LeaseOwner, 'schemaVersion'> {
  readonly schemaVersion: typeof RECOVERY_SCHEMA
  readonly targetNonce: string
}

type OwnerStatus =
  | 'active'
  | 'dead'
  | 'pid_reused'
  | 'previous_boot'
  | 'ambiguous'
  | 'corrupt'

export interface StateRootLeaseSnapshot {
  readonly status: 'active'
  readonly hostKind: StateRootHostKind
  readonly acquiredAt: string
  readonly sharedReferences: number
}

export class StateRootLeaseError extends CairnError {
  readonly ownerKind: StateRootHostKind | null

  constructor(
    code: string,
    message: string,
    ownerKind: StateRootHostKind | null = null,
    options: ErrorOptions = {},
  ) {
    super(message, code, {
      ...options,
      action: 'close_other_cairn_host',
    })
    this.ownerKind = ownerKind
  }
}

interface SharedLease {
  readonly key: string
  readonly stateRoot: string
  readonly path: string
  readonly recoveryPath: string
  readonly owner: LeaseOwner
  references: number
}

const ACTIVE_LEASES = new Map<string, SharedLease>()

export class StateRootLease {
  private released = false

  private constructor(private readonly shared: SharedLease) {}

  static acquire(
    stateRoot: string,
    hostKind: StateRootHostKind = 'core',
  ): StateRootLease {
    const canonicalRoot = canonicalStateRoot(stateRoot)
    const key =
      process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot
    const active = ACTIVE_LEASES.get(key)
    if (active) {
      active.references += 1
      return new StateRootLease(active)
    }

    const path = join(canonicalRoot, LEASE_FILE)
    const recoveryPath = join(canonicalRoot, RECOVERY_FILE)
    clearStaleRecovery(recoveryPath)
    if (existsSync(recoveryPath))
      throw conflictError(readRecovery(recoveryPath)?.hostKind ?? null)

    const identity = currentStableProcessIdentity()
    const owner: LeaseOwner = {
      schemaVersion: OWNER_SCHEMA,
      nonce: randomUUID(),
      hostKind,
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      bootMarker: identity.bootMarker,
      processStartIdentity: identity.processStartIdentity,
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (publishAtomic(path, owner)) {
        if (existsSync(recoveryPath)) {
          releaseOwnedFile(path, owner.nonce)
          clearStaleRecovery(recoveryPath)
          continue
        }
        const shared: SharedLease = {
          key,
          stateRoot: canonicalRoot,
          path,
          recoveryPath,
          owner,
          references: 1,
        }
        ACTIVE_LEASES.set(key, shared)
        return new StateRootLease(shared)
      }

      const current = diagnoseOwner(path)
      if (!isRecoverable(current.status))
        throw ownerError(current.status, current.owner?.hostKind ?? null)
      if (!recoverOwner(path, recoveryPath, current.owner!))
        continue
    }

    const current = diagnoseOwner(path)
    throw ownerError(current.status, current.owner?.hostKind ?? null)
  }

  snapshot(): StateRootLeaseSnapshot {
    return {
      status: 'active',
      hostKind: this.shared.owner.hostKind,
      acquiredAt: this.shared.owner.acquiredAt,
      sharedReferences: this.shared.references,
    }
  }

  release(): void {
    if (this.released) return
    this.released = true
    const active = ACTIVE_LEASES.get(this.shared.key)
    if (active !== this.shared) return
    active.references -= 1
    if (active.references > 0) return
    try {
      releaseOwnedFile(active.path, active.owner.nonce)
    } finally {
      ACTIVE_LEASES.delete(active.key)
    }
  }
}

function canonicalStateRoot(stateRoot: string): string {
  const requested = resolve(stateRoot)
  mkdirSync(requested, { recursive: true, mode: 0o700 })
  const canonical = realpathSync.native(requested)
  const metadata = lstatSync(canonical)
  if (!metadata.isDirectory())
    throw new StateRootLeaseError(
      'state_root_invalid',
      'Cairn 状态目录不是可用的本地目录。',
    )
  return canonical
}

function publishAtomic(path: string, value: LeaseOwner | RecoveryOwner): boolean {
  const temporary = `${path}.claim-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    try {
      linkSync(temporary, path)
      try {
        chmodSync(path, 0o600)
      } catch {
        // Windows ACLs are authoritative; chmod is best effort there.
      }
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'ENOTEMPTY') return false
      throw new StateRootLeaseError(
        'state_root_lease_atomic_unsupported',
        '当前文件系统不支持 Cairn 状态目录所需的原子租约。',
        null,
        { cause: error },
      )
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}

function recoverOwner(
  path: string,
  recoveryPath: string,
  expected: LeaseOwner,
): boolean {
  const identity = currentStableProcessIdentity()
  const recovery: RecoveryOwner = {
    schemaVersion: RECOVERY_SCHEMA,
    nonce: randomUUID(),
    targetNonce: expected.nonce,
    hostKind: 'core',
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
    bootMarker: identity.bootMarker,
    processStartIdentity: identity.processStartIdentity,
  }
  if (!publishAtomic(recoveryPath, recovery)) return false
  try {
    const current = diagnoseOwner(path)
    if (
      !current.owner ||
      current.owner.nonce !== expected.nonce ||
      !isRecoverable(current.status)
    )
      return false
    const retired = `${path}.stale-${expected.nonce}`
    try {
      renameSync(path, retired)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    rmSync(retired, { force: false })
    return true
  } finally {
    releaseOwnedFile(recoveryPath, recovery.nonce)
  }
}

function clearStaleRecovery(path: string): void {
  if (!existsSync(path)) return
  const owner = readRecovery(path)
  if (!owner) return
  const status = diagnose(owner)
  if (!isRecoverable(status)) return
  releaseOwnedFile(path, owner.nonce)
}

function releaseOwnedFile(path: string, nonce: string): void {
  if (!existsSync(path)) return
  const current = readAnyOwner(path)
  if (!current || current.nonce !== nonce)
    throw new StateRootLeaseError(
      'state_root_lease_owner_changed',
      'Cairn 状态目录租约在释放前发生了所有权变化。',
    )
  const released = `${path}.release-${nonce}`
  renameSync(path, released)
  rmSync(released, { force: false })
}

function diagnoseOwner(path: string): { status: OwnerStatus; owner: LeaseOwner | null } {
  const owner = readOwner(path)
  return owner ? { status: diagnose(owner), owner } : { status: 'corrupt', owner: null }
}

function diagnose(owner: LeaseOwner | RecoveryOwner): OwnerStatus {
  if (owner.hostname.toLowerCase() !== hostname().toLowerCase()) return 'ambiguous'
  const currentIdentity = currentStableProcessIdentity()
  if (
    owner.bootMarker &&
    currentIdentity.bootMarker &&
    owner.bootMarker !== currentIdentity.bootMarker
  )
    return 'previous_boot'
  if (!pidIsAlive(owner.pid)) return 'dead'
  if (!owner.processStartIdentity || !owner.bootMarker) return 'ambiguous'
  const current = stableProcessStartIdentity(owner.pid, owner.bootMarker)
  if (!current) return 'ambiguous'
  const comparison = compareStableProcessStartIdentity(
    owner.processStartIdentity,
    current,
  )
  if (comparison === 'same') return 'active'
  return comparison === 'different' ? 'pid_reused' : 'ambiguous'
}

function readOwner(path: string): LeaseOwner | null {
  const value = readJsonRecord(path)
  return value?.schemaVersion === OWNER_SCHEMA ? parseOwner(value) : null
}

function readRecovery(path: string): RecoveryOwner | null {
  const value = readJsonRecord(path)
  if (value?.schemaVersion !== RECOVERY_SCHEMA) return null
  const owner = parseOwner(value)
  return owner && typeof value.targetNonce === 'string' && value.targetNonce
    ? ({
        ...owner,
        schemaVersion: RECOVERY_SCHEMA,
        targetNonce: value.targetNonce,
      } as RecoveryOwner)
    : null
}

function readAnyOwner(path: string): LeaseOwner | RecoveryOwner | null {
  return readOwner(path) ?? readRecovery(path)
}

function readJsonRecord(path: string): Record<string, unknown> | null {
  try {
    if (!lstatSync(path).isFile()) return null
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function parseOwner(value: Record<string, unknown>): LeaseOwner | null {
  const identity =
    value.processStartIdentity === null
      ? null
      : parseStableProcessStartIdentity(value.processStartIdentity)
  if (
    typeof value.nonce !== 'string' ||
    !value.nonce ||
    (value.hostKind !== 'core' &&
      value.hostKind !== 'desktop' &&
      value.hostKind !== 'acp') ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    typeof value.hostname !== 'string' ||
    !value.hostname ||
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
    nonce: value.nonce,
    hostKind: value.hostKind,
    pid: Number(value.pid),
    hostname: value.hostname,
    acquiredAt: value.acquiredAt,
    bootMarker: value.bootMarker as string | null,
    processStartIdentity: identity,
  }
}

function isRecoverable(status: OwnerStatus): boolean {
  return status === 'dead' || status === 'pid_reused' || status === 'previous_boot'
}

function ownerError(
  status: OwnerStatus,
  ownerKind: StateRootHostKind | null,
): StateRootLeaseError {
  if (status === 'active' || status === 'ambiguous') return conflictError(ownerKind)
  if (status === 'corrupt')
    return new StateRootLeaseError(
      'state_root_lease_corrupt',
      'Cairn 状态目录租约已损坏；为保护本地数据，启动已停止。',
      ownerKind,
    )
  return conflictError(ownerKind)
}

function conflictError(ownerKind: StateRootHostKind | null): StateRootLeaseError {
  const label =
    ownerKind === 'desktop'
      ? '桌面端'
      : ownerKind === 'acp'
        ? 'ACP'
        : '另一个 Cairn 进程'
  return new StateRootLeaseError(
    'state_root_in_use',
    `Cairn 状态目录正由${label}使用。请关闭该实例后重试。`,
    ownerKind,
  )
}
