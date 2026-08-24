import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GoalGateMutationLedger } from './mutation-ledger'
import { PlanStore } from '../plans/store'
import { makePlanRecord, PlanStatus } from '../plans/models'
import { ControlStore } from '../control/store'
import { TaskManager } from '../tasks/manager'
import { TaskKind } from '../tasks/models'
import { GoalMutationGuard } from './mutation-guard'
import { canonicalJson } from './events'
import { currentStableProcessIdentity } from '../util/stable-process-identity'

describe('GoalGateMutationLedger', () => {
  it('serializes ledger RMW across two independent Node processes without losing epochs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-mutations-xproc-'))
    const readyA = join(root, 'ready-a')
    const readyB = join(root, 'ready-b')
    const go = join(root, 'go')
    const count = 80
    const first = mutationChild(root, {
      CAIRN_MUTATION_OPERATION: 'loop',
      CAIRN_MUTATION_PREFIX: 'a',
      CAIRN_MUTATION_COUNT: String(count),
      CAIRN_MUTATION_READY: readyA,
      CAIRN_MUTATION_GO: go,
    })
    const second = mutationChild(root, {
      CAIRN_MUTATION_OPERATION: 'loop',
      CAIRN_MUTATION_PREFIX: 'b',
      CAIRN_MUTATION_COUNT: String(count),
      CAIRN_MUTATION_READY: readyB,
      CAIRN_MUTATION_GO: go,
    })
    await waitUntil(() => existsSync(readyA) && existsSync(readyB))
    writeFileSync(go, 'go')
    await Promise.all([first, second])

    expect(new GoalGateMutationLedger(root).inspect().epoch).toBe(count * 2)
  }, 20_000)

  it('rejects a second-process mutation while a terminal precondition owns the state-root guard', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-mutations-xproc-'))
    const ledger = new GoalGateMutationLedger(root)
    const expected = ledger.inspect()
    let childFailure = ''

    await ledger.withTerminalPrecondition(expected, async () => {
      childFailure = await mutationChild(root, {
        CAIRN_MUTATION_OPERATION: 'plan-store',
      }).then(
        () => '',
        (error) => String(error),
      )
    })

    expect(childFailure).toContain('goal_mutation_guard_busy')
    expect(ledger.inspect()).toEqual(expected)
  }, 20_000)

  it('writes the current owner schema and accepts its previous persisted form', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-mutations-stale-'))
    const ledger = new GoalGateMutationLedger(root)
    const guard = new GoalMutationGuard(root, {
      staleMs: 1_000,
      timeoutMs: 20,
    })
    const owner = guard.runExclusiveSync(
      'mutation',
      () => JSON.parse(readFileSync(guard.ownerPath, 'utf8')) as object,
    )
    expect(owner).toMatchObject({
      schemaVersion: 'cairn.goal.mutation-guard-owner',
    })
    mkdirSync(guard.path, { recursive: true })
    writeFileSync(
      guard.ownerPath,
      JSON.stringify({
        ...owner,
        schemaVersion: 'cairn.goal.mutation-guard-owner.v2',
        pid: 999_999_999,
        nonce: 'dead-owner-nonce',
      }),
    )
    const old = new Date(Date.now() - 120_000)
    utimesSync(guard.path, old, old)

    expect(ledger.record('runtime', 'after-crash')).toMatchObject({ epoch: 1 })
  })

  it('keeps a dead legacy owner fail-closed until exact operator recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-mutations-legacy-'))
    const guard = new GoalMutationGuard(root, {
      staleMs: 1_000,
      timeoutMs: 10,
    })
    mkdirSync(guard.path, { recursive: true })
    writeFileSync(
      guard.ownerPath,
      JSON.stringify({
        schemaVersion: 'cairn.goal.mutation-guard-owner.v1',
        pid: 999_999_999,
        hostname: hostname(),
        nonce: 'dead-legacy-owner-nonce',
        purpose: 'mutation',
        acquiredAt: '2020-01-01T00:00:00.000Z',
      }),
    )
    const old = new Date(Date.now() - 120_000)
    utimesSync(guard.path, old, old)

    const diagnostic = guard.diagnoseOwner()
    expect(diagnostic).toMatchObject({
      status: 'ambiguous',
      nonce: 'dead-legacy-owner-nonce',
    })
    expect(() =>
      guard.runExclusiveSync('mutation', () => undefined),
    ).toThrowError(
      expect.objectContaining({ code: 'goal_mutation_guard_busy' }),
    )
    expect(
      guard.recoverStaleOwner({
        expectedOwnerSha256: diagnostic.ownerSha256!,
        expectedNonce: 'dead-legacy-owner-nonce',
        confirmedOwnerStale: true,
      }),
    ).toBe(true)
  })

  it('never age-deletes a stale-looking lock while its local owner pid is alive', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-mutations-live-'))
    const guard = new GoalMutationGuard(root, {
      staleMs: 1_000,
      timeoutMs: 10,
    })
    mkdirSync(guard.path, { recursive: true })
    writeFileSync(
      guard.ownerPath,
      JSON.stringify({
        schemaVersion: 'cairn.goal.mutation-guard-owner.v1',
        pid: process.pid,
        hostname: hostname(),
        nonce: 'live-owner-nonce',
        purpose: 'mutation',
        acquiredAt: '2020-01-01T00:00:00.000Z',
      }),
    )
    const old = new Date(Date.now() - 120_000)
    utimesSync(guard.path, old, old)

    expect(() =>
      guard.runExclusiveSync('mutation', () => undefined),
    ).toThrowError(
      expect.objectContaining({ code: 'goal_mutation_guard_busy' }),
    )
    expect(existsSync(guard.ownerPath)).toBe(true)

    const diagnostic = guard.diagnoseOwner()
    expect(diagnostic).toMatchObject({
      status: 'ambiguous',
      nonce: 'live-owner-nonce',
    })
    expect(
      guard.recoverStaleOwner({
        expectedOwnerSha256: diagnostic.ownerSha256!,
        expectedNonce: 'wrong-nonce',
        confirmedOwnerStale: true,
      }),
    ).toBe(false)
    expect(
      guard.recoverStaleOwner({
        expectedOwnerSha256: diagnostic.ownerSha256!,
        expectedNonce: 'live-owner-nonce',
        confirmedOwnerStale: true,
      }),
    ).toBe(true)
    expect(() =>
      guard.runExclusiveSync('mutation', () => undefined),
    ).not.toThrow()
    expect(readFileSync(guard.recoveryAuditPath, 'utf8')).toContain(
      'operator-ambiguous-recovery',
    )
  })

  it('recovers a stale owner after proving that its live PID was reused', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-mutations-reused-'))
    const guard = new GoalMutationGuard(root, {
      staleMs: 1_000,
      timeoutMs: 20,
    })
    const owner = guard.runExclusiveSync(
      'mutation',
      () =>
        JSON.parse(readFileSync(guard.ownerPath, 'utf8')) as Record<
          string,
          unknown
        >,
    )
    const identity = owner.processStartIdentity as Record<string, unknown>
    mkdirSync(guard.path, { recursive: true })
    writeFileSync(
      guard.ownerPath,
      JSON.stringify({
        ...owner,
        nonce: 'reused-owner-nonce',
        processStartIdentity:
          identity.kind === 'darwin_boot_relative_interval'
            ? {
                ...identity,
                minSeconds: Number(identity.maxSeconds) + 100,
                maxSeconds: Number(identity.maxSeconds) + 101,
              }
            : { ...identity, value: '0'.repeat(64) },
      }),
    )
    const old = new Date(Date.now() - 120_000)
    utimesSync(guard.path, old, old)

    expect(guard.diagnoseOwner().status).toBe('pid_reused')
    expect(() =>
      guard.runExclusiveSync('mutation', () => undefined),
    ).not.toThrow()
    expect(readFileSync(guard.recoveryAuditPath, 'utf8')).toContain(
      'pid_reused',
    )
  })

  it('keeps a corrupt owner fail-closed until raw-hash-confirmed recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-mutations-corrupt-'))
    const guard = new GoalMutationGuard(root, {
      staleMs: 1_000,
      timeoutMs: 10,
    })
    mkdirSync(guard.path, { recursive: true })
    writeFileSync(guard.ownerPath, '{corrupt owner')
    const old = new Date(Date.now() - 120_000)
    utimesSync(guard.path, old, old)
    const diagnostic = guard.diagnoseOwner()
    expect(diagnostic).toMatchObject({ status: 'corrupt', nonce: null })
    expect(() =>
      guard.runExclusiveSync('mutation', () => undefined),
    ).toThrowError(
      expect.objectContaining({ code: 'goal_mutation_guard_busy' }),
    )
    expect(
      guard.recoverStaleOwner({
        expectedOwnerSha256: '0'.repeat(64),
        confirmedOwnerStale: true,
      }),
    ).toBe(false)
    expect(
      guard.recoverStaleOwner({
        expectedOwnerSha256: diagnostic.ownerSha256!,
        confirmedOwnerStale: true,
      }),
    ).toBe(true)
    expect(() =>
      guard.runExclusiveSync('mutation', () => undefined),
    ).not.toThrow()
    expect(readFileSync(guard.recoveryAuditPath, 'utf8')).toContain(
      'operator-corrupt-recovery',
    )
  })

  it('retries a marker-only interrupted recovery before entering the action', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-recovery-marker-'))
    let failBeforeAudit = true
    const guard = new GoalMutationGuard(root, {
      staleMs: 1_000,
      timeoutMs: 200,
      beforeRecoveryAudit: () => {
        if (!failBeforeAudit) return
        failBeforeAudit = false
        throw new Error('simulated recovery crash')
      },
    })
    const owner = guard.runExclusiveSync(
      'mutation',
      () => JSON.parse(readFileSync(guard.ownerPath, 'utf8')) as object,
    )
    writeFileSync(
      guard.path,
      JSON.stringify({
        ...owner,
        pid: 999_999_999,
        nonce: 'dead-owner-before-audit',
      }),
    )
    const old = new Date(Date.now() - 120_000)
    utimesSync(guard.path, old, old)

    expect(() =>
      guard.runExclusiveSync('mutation', () => undefined),
    ).not.toThrow()
    expect(existsSync(guard.recoveryMarkerPath)).toBe(false)
    expect(readFileSync(guard.recoveryAuditPath, 'utf8')).toContain(
      'dead-owner-before-audit',
    )
  })

  it('repairs only a partial audit tail from an atomic intent before completing recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-audit-tail-'))
    const guard = new GoalMutationGuard(root, {
      staleMs: 1_000,
      timeoutMs: 50,
    })
    const firstOwner = guard.runExclusiveSync(
      'mutation',
      () => JSON.parse(readFileSync(guard.ownerPath, 'utf8')) as object,
    )
    writeFileSync(
      guard.path,
      JSON.stringify({
        ...firstOwner,
        pid: 999_999_999,
        nonce: 'dead-owner-first-audit',
      }),
    )
    const old = new Date(Date.now() - 120_000)
    utimesSync(guard.path, old, old)
    const secondOwner = guard.runExclusiveSync(
      'mutation',
      () => JSON.parse(readFileSync(guard.ownerPath, 'utf8')) as object,
    )

    appendFileSync(guard.recoveryAuditPath, '{"partial":', 'utf8')
    writeFileSync(
      guard.path,
      JSON.stringify({
        ...secondOwner,
        pid: 999_999_998,
        nonce: 'dead-owner-second-audit',
      }),
    )
    utimesSync(guard.path, old, old)
    expect(() =>
      guard.runExclusiveSync('mutation', () => undefined),
    ).not.toThrow()

    const records = readFileSync(guard.recoveryAuditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records).toHaveLength(2)
    expect(records.map((record) => record.previousNonce)).toEqual([
      'dead-owner-first-audit',
      'dead-owner-second-audit',
    ])
  })

  it('keeps the marker after owner removal until completion audit retry succeeds', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-audit-retry-'))
    let failCompletion = true
    const guard = new GoalMutationGuard(root, {
      staleMs: 1_000,
      timeoutMs: 50,
      beforeRecoveryCompletion: () => {
        if (!failCompletion) return
        failCompletion = false
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75)
        throw new Error('simulated completion audit failure')
      },
    })
    const owner = guard.runExclusiveSync(
      'mutation',
      () => JSON.parse(readFileSync(guard.ownerPath, 'utf8')) as object,
    )
    writeFileSync(
      guard.path,
      JSON.stringify({
        ...owner,
        pid: 999_999_999,
        nonce: 'dead-owner-audit-retry',
      }),
    )
    const old = new Date(Date.now() - 120_000)
    utimesSync(guard.path, old, old)

    expect(() =>
      guard.runExclusiveSync('mutation', () => undefined),
    ).not.toThrow()
    expect(existsSync(guard.recoveryMarkerPath)).toBe(false)
    expect(readFileSync(guard.recoveryAuditPath, 'utf8')).toContain(
      'dead-owner-audit-retry',
    )
  })

  it('drops a stale old-generation marker before releasing the live replacement owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-old-marker-'))
    const guard = new GoalMutationGuard(root)
    const currentIdentity = currentStableProcessIdentity()

    expect(() =>
      guard.runExclusiveSync('mutation', () => {
        const markerBase = {
          schemaVersion: 'cairn.goal.mutation-guard-recovery-marker.v1',
          recoveryId: '2'.repeat(64),
          reason: 'dead',
          expectedStatus: 'dead',
          expectedNonce: 'old-generation-owner',
          expectedOwnerSha256: '0'.repeat(64),
          expectedPathIdentitySha256: '1'.repeat(64),
          recoveryPid: 999_999_999,
          recoveryHostname: hostname(),
          recoveryBootMarker: currentIdentity.bootMarker,
          recoveryProcessStartIdentity: currentIdentity.processStartIdentity,
        }
        writeFileSync(
          guard.recoveryMarkerPath,
          JSON.stringify({
            ...markerBase,
            integritySha256: createHash('sha256')
              .update(canonicalJson(markerBase), 'utf8')
              .digest('hex'),
          }),
        )
      }),
    ).not.toThrow()
    expect(existsSync(guard.recoveryMarkerPath)).toBe(false)
    expect(() =>
      guard.runExclusiveSync('mutation', () => undefined),
    ).not.toThrow()
  })

  it('does not replace an owner directory whose raw owner bytes are unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-mutations-empty-'))
    const guard = new GoalMutationGuard(root, {
      staleMs: 1_000,
      timeoutMs: 10,
    })
    mkdirSync(guard.path, { recursive: true })
    const old = new Date(Date.now() - 120_000)
    utimesSync(guard.path, old, old)

    const diagnostic = guard.diagnoseOwner()
    expect(diagnostic).toMatchObject({
      status: 'corrupt',
      nonce: null,
      ownerSha256: null,
      pathIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(
      guard.recoverStaleOwner({
        expectedOwnerSha256:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        confirmedOwnerStale: true,
      }),
    ).toBe(false)
    expect(
      guard.recoverStaleOwner({
        expectedPathIdentitySha256: diagnostic.pathIdentitySha256!,
        confirmedOwnerStale: true,
      }),
    ).toBe(true)
    expect(() =>
      guard.runExclusiveSync('mutation', () => undefined),
    ).not.toThrow()
  })

  it('diagnoses a missing recovery marker without creating state', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-marker-missing-'))
    const guard = new GoalMutationGuard(root)

    expect(guard.diagnoseRecoveryMarker()).toEqual({
      status: 'missing',
      markerPath: guard.recoveryMarkerPath,
      rawMarkerSha256: null,
      recoveryId: null,
      intentPath: null,
      intentSha256: null,
      intentValid: false,
      expectedOwnerSha256: null,
      expectedPathIdentitySha256: null,
      expectedNonce: null,
      currentOwner: expect.objectContaining({ status: 'missing' }),
      markerOwnerStatus: null,
    })
    expect(existsSync(join(root, 'goals'))).toBe(false)
  })

  it('purely diagnoses active, stale, and identity-ambiguous recovery markers', () => {
    const fixture = interruptedRecoveryMarker('cairn-goal-marker-diagnostics-')
    const markerBefore = readFileSync(fixture.guard.recoveryMarkerPath)
    const intentBefore = readFileSync(fixture.intentPath)
    const namesBefore = readdirSync(fixture.guard.recoveryIntentsDir).sort()

    expect(fixture.guard.diagnoseRecoveryMarker()).toMatchObject({
      status: 'active',
      rawMarkerSha256: sha256Bytes(markerBefore),
      recoveryId: fixture.recoveryId,
      intentPath: fixture.intentPath,
      intentSha256: sha256Bytes(intentBefore),
      intentValid: true,
      expectedOwnerSha256: fixture.intent.previousOwnerSha256,
      expectedPathIdentitySha256: fixture.intent.previousPathIdentitySha256,
      expectedNonce: fixture.intent.previousNonce,
      currentOwner: { status: 'missing' },
      markerOwnerStatus: 'active',
    })

    rewriteRecoveryMarker(fixture.guard, {
      recoveryPid: 999_999_999,
    })
    expect(fixture.guard.diagnoseRecoveryMarker()).toMatchObject({
      status: 'stale',
      recoveryId: fixture.recoveryId,
      intentValid: true,
      currentOwner: { status: 'missing' },
      markerOwnerStatus: 'stale',
    })

    rewriteRecoveryMarker(fixture.guard, {
      recoveryPid: process.pid,
      recoveryProcessStartIdentity: null,
    })
    expect(fixture.guard.diagnoseRecoveryMarker()).toMatchObject({
      status: 'ambiguous',
      recoveryId: fixture.recoveryId,
      intentValid: true,
      currentOwner: { status: 'missing' },
      markerOwnerStatus: 'ambiguous',
    })

    expect(readFileSync(fixture.intentPath)).toEqual(intentBefore)
    expect(readdirSync(fixture.guard.recoveryIntentsDir).sort()).toEqual(
      namesBefore,
    )
  })

  it('associates corrupt marker bytes with one exact durable intent but never guesses among multiple intents', () => {
    const fixture = interruptedRecoveryMarker('cairn-goal-marker-corrupt-')
    const corrupt = Buffer.from('{corrupt recovery marker', 'utf8')
    writeFileSync(fixture.guard.recoveryMarkerPath, corrupt)

    expect(fixture.guard.diagnoseRecoveryMarker()).toMatchObject({
      status: 'corrupt',
      rawMarkerSha256: sha256Bytes(corrupt),
      recoveryId: null,
      intentPath: fixture.intentPath,
      intentSha256: sha256Bytes(readFileSync(fixture.intentPath)),
      intentValid: true,
      expectedOwnerSha256: fixture.intent.previousOwnerSha256,
      expectedPathIdentitySha256: fixture.intent.previousPathIdentitySha256,
      expectedNonce: fixture.intent.previousNonce,
      currentOwner: { status: 'missing' },
      markerOwnerStatus: null,
    })

    const secondRecoveryId = '9'.repeat(64)
    const { integritySha256: _ignored, ...intentBase } = fixture.intent
    const secondBase = { ...intentBase, recoveryId: secondRecoveryId }
    const secondIntent = {
      ...secondBase,
      integritySha256: sha256Canonical(secondBase),
    }
    writeFileSync(
      join(fixture.guard.recoveryIntentsDir, `${secondRecoveryId}.json`),
      JSON.stringify(secondIntent),
    )

    expect(fixture.guard.diagnoseRecoveryMarker()).toMatchObject({
      status: 'corrupt',
      rawMarkerSha256: sha256Bytes(corrupt),
      recoveryId: null,
      intentPath: null,
      intentSha256: null,
      intentValid: false,
      expectedOwnerSha256: null,
      expectedPathIdentitySha256: null,
      expectedNonce: null,
      markerOwnerStatus: null,
    })
  })

  it.each(['stale', 'ambiguous', 'corrupt'] as const)(
    'recovers only an exact confirmed %s marker and records one operator audit',
    (status) => {
      const fixture = interruptedRecoveryMarker(
        `cairn-goal-marker-recover-${status}-`,
      )
      if (status === 'stale')
        rewriteRecoveryMarker(fixture.guard, { recoveryPid: 999_999_999 })
      else if (status === 'ambiguous')
        rewriteRecoveryMarker(fixture.guard, {
          recoveryProcessStartIdentity: null,
        })
      else
        writeFileSync(
          fixture.guard.recoveryMarkerPath,
          '{corrupt recovery marker',
        )
      const diagnostic = fixture.guard.diagnoseRecoveryMarker()
      const input = staleMarkerRecoveryInput(fixture, diagnostic)
      const before = readFileSync(fixture.guard.recoveryMarkerPath)

      expect(
        fixture.guard.recoverStaleMarker({
          ...input,
          expectedRawMarkerSha256: '0'.repeat(64),
        }),
      ).toBe(false)
      expect(
        fixture.guard.recoverStaleMarker({
          ...input,
          expectedRecoveryId: '1'.repeat(64),
        }),
      ).toBe(false)
      expect(
        fixture.guard.recoverStaleMarker({
          ...input,
          expectedIntentSha256: '2'.repeat(64),
        }),
      ).toBe(false)
      expect(
        fixture.guard.recoverStaleMarker({
          ...input,
          expectedPathIdentitySha256: '3'.repeat(64),
        }),
      ).toBe(false)
      expect(readFileSync(fixture.guard.recoveryMarkerPath)).toEqual(before)

      expect(fixture.guard.recoverStaleMarker(input)).toBe(true)
      expect(existsSync(fixture.guard.recoveryMarkerPath)).toBe(false)
      const audit = readFileSync(fixture.guard.recoveryAuditPath, 'utf8')
      expect(audit).toContain(`operator-${status}-marker-recovery`)
      expect(fixture.guard.recoverStaleMarker(input)).toBe(false)
      expect(readFileSync(fixture.guard.recoveryAuditPath, 'utf8')).toBe(audit)
    },
  )

  it('uses exact operator proof to select one corrupt-marker intent without deleting historical intents', () => {
    const fixture = interruptedRecoveryMarker(
      'cairn-goal-marker-multi-intent-recover-',
    )
    const corrupt = Buffer.from('{corrupt recovery marker', 'utf8')
    writeFileSync(fixture.guard.recoveryMarkerPath, corrupt)
    const secondRecoveryId = '8'.repeat(64)
    const { integritySha256: _ignored, ...intentBase } = fixture.intent
    const secondBase = { ...intentBase, recoveryId: secondRecoveryId }
    const secondPath = join(
      fixture.guard.recoveryIntentsDir,
      `${secondRecoveryId}.json`,
    )
    writeFileSync(
      secondPath,
      JSON.stringify({
        ...secondBase,
        integritySha256: sha256Canonical(secondBase),
      }),
    )
    const exactInput = {
      expectedRawMarkerSha256: sha256Bytes(corrupt),
      expectedRecoveryId: fixture.recoveryId,
      expectedIntentSha256: sha256Bytes(readFileSync(fixture.intentPath)),
      expectedOwnerSha256: fixture.intent.previousOwnerSha256 as string,
      expectedPathIdentitySha256: fixture.intent
        .previousPathIdentitySha256 as string,
      expectedNonce: fixture.intent.previousNonce as string | null,
      confirmedMarkerStale: true as const,
    }

    expect(
      fixture.guard.recoverStaleMarker({
        ...exactInput,
        expectedRecoveryId: secondRecoveryId,
      }),
    ).toBe(false)
    expect(fixture.guard.recoverStaleMarker(exactInput)).toBe(true)
    expect(existsSync(fixture.intentPath)).toBe(true)
    expect(existsSync(secondPath)).toBe(true)
  })

  it('rejects active markers and replacement owners without changing either path', () => {
    const active = interruptedRecoveryMarker('cairn-goal-marker-active-')
    const activeDiagnostic = active.guard.diagnoseRecoveryMarker()
    const activeBytes = readFileSync(active.guard.recoveryMarkerPath)
    expect(
      active.guard.recoverStaleMarker(
        staleMarkerRecoveryInput(active, activeDiagnostic),
      ),
    ).toBe(false)
    expect(readFileSync(active.guard.recoveryMarkerPath)).toEqual(activeBytes)

    const replaced = interruptedRecoveryMarker('cairn-goal-marker-replacement-')
    rewriteRecoveryMarker(replaced.guard, { recoveryPid: 999_999_999 })
    const replacedDiagnostic = replaced.guard.diagnoseRecoveryMarker()
    writeFileSync(replaced.guard.path, '{replacement owner')
    const replacementBytes = readFileSync(replaced.guard.path)
    expect(
      replaced.guard.recoverStaleMarker(
        staleMarkerRecoveryInput(replaced, replacedDiagnostic),
      ),
    ).toBe(false)
    expect(readFileSync(replaced.guard.path)).toEqual(replacementBytes)
    expect(existsSync(replaced.guard.recoveryMarkerPath)).toBe(true)
  })

  it('removes an exact still-present stale owner but preserves a marker replaced after operator claim', () => {
    const exact = interruptedRecoveryMarker('cairn-goal-marker-exact-owner-')
    rewriteRecoveryMarker(exact.guard, { recoveryPid: 999_999_999 })
    linkSync(exact.ownerBackupPath, exact.guard.path)
    const exactDiagnostic = exact.guard.diagnoseRecoveryMarker()
    expect(exactDiagnostic.currentOwner).toMatchObject({
      status: 'corrupt',
      ownerSha256: exact.intent.previousOwnerSha256,
      pathIdentitySha256: exact.intent.previousPathIdentitySha256,
    })
    expect(
      exact.guard.recoverStaleMarker(
        staleMarkerRecoveryInput(exact, exactDiagnostic),
      ),
    ).toBe(true)
    expect(existsSync(exact.guard.path)).toBe(false)

    const replaced = interruptedRecoveryMarker(
      'cairn-goal-marker-cas-replaced-',
    )
    rewriteRecoveryMarker(replaced.guard, { recoveryPid: 999_999_999 })
    const input = staleMarkerRecoveryInput(
      replaced,
      replaced.guard.diagnoseRecoveryMarker(),
    )
    const replacement = Buffer.from('{replacement marker', 'utf8')
    const racing = new GoalMutationGuard(replaced.root, {
      afterOperatorRecoveryClaim: () =>
        writeFileSync(racing.recoveryMarkerPath, replacement),
    })
    expect(racing.recoverStaleMarker(input)).toBe(false)
    expect(readFileSync(racing.recoveryMarkerPath)).toEqual(replacement)
  })

  it.each([
    'afterOperatorRecoveryClaim',
    'beforeMarkerRecoveryCompletion',
    'beforeMarkerRecoveryRemove',
  ] as const)('retries safely after a crash hook at %s', (hook) => {
    const fixture = interruptedRecoveryMarker(
      `cairn-goal-marker-crash-${hook}-`,
    )
    rewriteRecoveryMarker(fixture.guard, { recoveryPid: 999_999_999 })
    let crash = true
    const crashing = new GoalMutationGuard(fixture.root, {
      [hook]: () => {
        if (!crash) return
        crash = false
        throw new Error(`simulated ${hook} crash`)
      },
    })
    const diagnostic = crashing.diagnoseRecoveryMarker()
    const input = staleMarkerRecoveryInput(fixture, diagnostic)

    expect(crashing.recoverStaleMarker(input)).toBe(false)
    expect(existsSync(crashing.recoveryMarkerPath)).toBe(true)
    expect(new GoalMutationGuard(fixture.root).recoverStaleMarker(input)).toBe(
      true,
    )
    expect(existsSync(crashing.recoveryMarkerPath)).toBe(false)
  })

  it('allows at most one cross-process operator to recover the exact marker', async () => {
    const fixture = interruptedRecoveryMarker(
      'cairn-goal-marker-operator-race-',
    )
    rewriteRecoveryMarker(fixture.guard, { recoveryPid: 999_999_999 })
    const input = staleMarkerRecoveryInput(
      fixture,
      fixture.guard.diagnoseRecoveryMarker(),
    )
    const readyA = join(fixture.root, 'operator-ready-a')
    const readyB = join(fixture.root, 'operator-ready-b')
    const resultA = join(fixture.root, 'operator-result-a')
    const resultB = join(fixture.root, 'operator-result-b')
    const go = join(fixture.root, 'operator-go')
    const children = [
      mutationChild(fixture.root, {
        CAIRN_MUTATION_OPERATION: 'recover-marker',
        CAIRN_MUTATION_READY: readyA,
        CAIRN_MUTATION_GO: go,
        CAIRN_MUTATION_RESULT: resultA,
        CAIRN_MUTATION_RECOVERY_INPUT: JSON.stringify(input),
      }),
      mutationChild(fixture.root, {
        CAIRN_MUTATION_OPERATION: 'recover-marker',
        CAIRN_MUTATION_READY: readyB,
        CAIRN_MUTATION_GO: go,
        CAIRN_MUTATION_RESULT: resultB,
        CAIRN_MUTATION_RECOVERY_INPUT: JSON.stringify(input),
      }),
    ]
    await waitUntil(() => existsSync(readyA) && existsSync(readyB))
    writeFileSync(go, 'go')
    await Promise.all(children)

    expect(
      [readFileSync(resultA, 'utf8'), readFileSync(resultB, 'utf8')].sort(),
    ).toEqual(['false', 'true'])
    expect(existsSync(fixture.guard.recoveryMarkerPath)).toBe(false)
  }, 20_000)

  it(
    'reclaims an operator claim left by a crashed process before retrying recovery',
    async () => {
      const fixture = interruptedRecoveryMarker(
        'cairn-goal-marker-operator-crash-',
      )
      rewriteRecoveryMarker(fixture.guard, { recoveryPid: 999_999_999 })
      const input = staleMarkerRecoveryInput(
        fixture,
        fixture.guard.diagnoseRecoveryMarker(),
      )
      await expect(
        markerRecoveryCrashChild(fixture.root, input),
      ).rejects.toThrow(/exited with 91/)
      expect(existsSync(fixture.guard.operatorRecoveryClaimPath)).toBe(true)
      await expect(
        markerRecoveryCrashChild(fixture.root, input, 'operator-reclaimer'),
      ).rejects.toThrow(/exited with 92/)
      expect(existsSync(fixture.guard.operatorRecoveryReclaimBarrierPath)).toBe(
        true,
      )
      await waitUntil(() => {
        try {
          return (
            Date.now() -
              statSync(fixture.guard.operatorRecoveryReclaimBarrierPath)
                .mtimeMs >=
            1_250
          )
        } catch {
          return false
        }
      })

      expect(
        new GoalMutationGuard(fixture.root, {
          timeoutMs: 15_000,
        }).recoverStaleMarker(input),
      ).toBe(true)
      expect(existsSync(fixture.guard.operatorRecoveryClaimPath)).toBe(false)
      expect(existsSync(fixture.guard.recoveryMarkerPath)).toBe(false)
    },
    process.platform === 'win32' ? 45_000 : 20_000,
  )

  it('never unlinks a replacement operator claim while reclaiming a crashed owner', async () => {
    const fixture = interruptedRecoveryMarker(
      'cairn-goal-marker-operator-replacement-',
    )
    rewriteRecoveryMarker(fixture.guard, { recoveryPid: 999_999_999 })
    const input = staleMarkerRecoveryInput(
      fixture,
      fixture.guard.diagnoseRecoveryMarker(),
    )
    await expect(markerRecoveryCrashChild(fixture.root, input)).rejects.toThrow(
      /exited with 91/,
    )
    const identity = currentStableProcessIdentity()
    const replacing = new GoalMutationGuard(fixture.root, {
      afterOperatorReclaimClaimed: () => {
        const stale = JSON.parse(
          readFileSync(fixture.guard.operatorRecoveryClaimPath, 'utf8'),
        )
        rmSync(fixture.guard.operatorRecoveryClaimPath, { force: false })
        writeFileSync(
          fixture.guard.operatorRecoveryClaimPath,
          JSON.stringify({
            ...stale,
            pid: process.pid,
            nonce: 'live_operator_replacement',
            acquiredAt: new Date().toISOString(),
            bootMarker: identity.bootMarker,
            processStartIdentity: identity.processStartIdentity,
          }),
        )
      },
    })

    expect(replacing.recoverStaleMarker(input)).toBe(false)
    expect(
      JSON.parse(readFileSync(fixture.guard.operatorRecoveryClaimPath, 'utf8'))
        .nonce,
    ).toBe('live_operator_replacement')
    expect(existsSync(fixture.guard.recoveryMarkerPath)).toBe(true)
  }, 20_000)

  it('keeps a stale marker fail-closed when its same-ID intent has the wrong typed proof', () => {
    const fixture = interruptedRecoveryMarker(
      'cairn-goal-marker-wrong-auto-intent-',
    )
    rewriteRecoveryMarker(fixture.guard, { recoveryPid: 999_999_999 })
    const { integritySha256: _ignored, ...intent } = fixture.intent
    const forged = {
      ...intent,
      schemaVersion: 'cairn.goal.unrelated-intent.v1',
      previousOwnerSha256: '7'.repeat(64),
    }
    writeFileSync(
      fixture.intentPath,
      JSON.stringify({
        ...forged,
        integritySha256: sha256Canonical(forged),
      }),
    )

    expect(() =>
      new GoalMutationGuard(fixture.root, { timeoutMs: 10 }).runExclusiveSync(
        'mutation',
        () => undefined,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'goal_mutation_guard_busy' }),
    )
    expect(existsSync(fixture.guard.recoveryMarkerPath)).toBe(true)
  })

  it('is a pure first read and persists monotonic typed source versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-mutations-'))
    const ledger = new GoalGateMutationLedger(root)

    expect(ledger.inspect()).toEqual({ epoch: 0, versions: {} })
    expect(existsSync(ledger.path)).toBe(false)

    const plan = ledger.record('plan', 'plan:7')
    const control = ledger.record('control', 'control:4')
    expect(plan).toEqual({ epoch: 1, versions: { plan: 'plan:7' } })
    expect(control).toEqual({
      epoch: 2,
      versions: { control: 'control:4', plan: 'plan:7' },
    })
    expect(new GoalGateMutationLedger(root).inspect()).toEqual(control)
  })

  it('atomically rejects stale epochs and blocks mutations during terminal validation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-mutations-'))
    const ledger = new GoalGateMutationLedger(root)
    const expected = ledger.record('plan', 'plan:1')
    ledger.record('task', 'task:2')

    await expect(
      ledger.withTerminalPrecondition(expected, async () => undefined),
    ).rejects.toMatchObject({ code: 'goal_terminal_precondition_conflict' })

    const fresh = ledger.inspect()
    await ledger.withTerminalPrecondition(fresh, async () => {
      expect(() => ledger.record('control', 'control:2')).toThrowError(
        expect.objectContaining({ code: 'goal_terminal_validation_active' }),
      )
    })
  })

  it('is bumped by production Plan, Control, Task, and transcript mutations', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-goal-mutations-'))
    const ledger = new GoalGateMutationLedger(root)
    const plans = new PlanStore(root)
    const control = new ControlStore(root)
    const tasks = new TaskManager(root)
    const baseline = ledger.inspect().epoch

    plans.save(
      makePlanRecord({
        id: 'plan_mutation',
        title: 'Mutation',
        summary: 'Mutation',
        status: PlanStatus.DRAFT,
        createdAt: 1,
        updatedAt: 1,
      }),
    )
    control.save(control.load())
    const task = tasks.startTask({
      kind: TaskKind.SUBAGENT,
      title: 'Mutation',
      source: 'test',
    })
    tasks.appendSidechain(task.id, { role: 'assistant', content: 'done' })

    const snapshot = ledger.inspect()
    expect(snapshot.epoch).toBeGreaterThanOrEqual(baseline + 4)
    expect(snapshot.versions).toMatchObject({
      plan: expect.stringContaining('plan_mutation'),
      control: expect.any(String),
      task: expect.stringContaining(task.id),
      transcript: expect.stringContaining(task.id),
    })
  })
})

function interruptedRecoveryMarker(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const guard = new GoalMutationGuard(root, {
    beforeRecoveryCompletion: () => {
      throw new Error('leave recovery marker and durable intent for diagnosis')
    },
  })
  mkdirSync(join(root, 'goals'), { recursive: true })
  writeFileSync(guard.path, '{corrupt stale owner')
  const ownerBackupPath = join(root, 'original-owner-backup')
  linkSync(guard.path, ownerBackupPath)
  const owner = guard.diagnoseOwner()
  const recovered = guard.recoverStaleOwner({
    expectedOwnerSha256: owner.ownerSha256,
    confirmedOwnerStale: true,
  })
  if (
    recovered ||
    existsSync(guard.path) ||
    !existsSync(guard.recoveryMarkerPath)
  )
    throw new Error('failed to prepare interrupted recovery marker fixture')
  const marker = JSON.parse(
    readFileSync(guard.recoveryMarkerPath, 'utf8'),
  ) as Record<string, unknown>
  const recoveryId = String(marker.recoveryId)
  const intentPath = join(guard.recoveryIntentsDir, `${recoveryId}.json`)
  const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as Record<
    string,
    unknown
  >
  return {
    root,
    guard,
    marker,
    recoveryId,
    intentPath,
    intent,
    ownerBackupPath,
  }
}

function rewriteRecoveryMarker(
  guard: GoalMutationGuard,
  changes: Record<string, unknown>,
): void {
  const current = JSON.parse(
    readFileSync(guard.recoveryMarkerPath, 'utf8'),
  ) as Record<string, unknown>
  const { integritySha256: _ignored, ...base } = current
  const nextBase = { ...base, ...changes }
  writeFileSync(
    guard.recoveryMarkerPath,
    JSON.stringify({
      ...nextBase,
      integritySha256: sha256Canonical(nextBase),
    }),
  )
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function sha256Bytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function staleMarkerRecoveryInput(
  fixture: ReturnType<typeof interruptedRecoveryMarker>,
  diagnostic: ReturnType<GoalMutationGuard['diagnoseRecoveryMarker']>,
) {
  return {
    expectedRawMarkerSha256: diagnostic.rawMarkerSha256!,
    expectedRecoveryId: fixture.recoveryId,
    expectedIntentSha256: diagnostic.intentSha256!,
    expectedOwnerSha256: diagnostic.expectedOwnerSha256,
    expectedPathIdentitySha256: diagnostic.expectedPathIdentitySha256,
    expectedNonce: diagnostic.expectedNonce,
    confirmedMarkerStale: true as const,
  }
}

function mutationChild(
  root: string,
  extra: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), '..', '..', 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        'src/goals/mutation-ledger-child.test.ts',
        '--pool=forks',
        '--maxWorkers=1',
        '--minWorkers=1',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CAIRN_MUTATION_CHILD: '1',
          CAIRN_MUTATION_ROOT: root,
          ...extra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (chunk) => (output += String(chunk)))
    child.stderr.on('data', (chunk) => (output += String(chunk)))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(output)),
    )
  })
}

function markerRecoveryCrashChild(
  root: string,
  input: Record<string, unknown>,
  crashPhase?: 'operator-reclaimer',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(
          process.cwd(),
          '..',
          '..',
          'node_modules',
          'vite-node',
          'vite-node.mjs',
        ),
        'src/goals/mutation-recovery-crash-child.ts',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CAIRN_MUTATION_ROOT: root,
          CAIRN_MUTATION_RECOVERY_INPUT: JSON.stringify(input),
          ...(crashPhase ? { CAIRN_MUTATION_CRASH_PHASE: crashPhase } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (chunk) => (output += String(chunk)))
    child.stderr.on('data', (chunk) => (output += String(chunk)))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`child exited with ${code}: ${output}`)),
    )
  })
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('child process did not become ready')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
