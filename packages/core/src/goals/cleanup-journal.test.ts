import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { GoalCleanupJournal } from './cleanup-journal'
import { canonicalJson } from './events'
import { currentStableProcessIdentity } from '../util/stable-process-identity'

describe('GoalCleanupJournal claim ownership', () => {
  it('publishes each new claim as one atomic owner file without an ownerless path stage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-atomic-'))
    const traces: Array<{ stage: string; diagnostic: { status: string } }> = []
    const journal = new GoalCleanupJournal(root, {
      onClaimTrace: (trace) => traces.push(trace),
    })
    const claim = await journal.claim({
      receiptId: 'receipt_atomic_claim',
      obligation: 'clear_active_run',
    })

    expect(claim).not.toBeNull()
    expect(lstatSync(claim!.path).isFile()).toBe(true)
    expect(traces.map((trace) => trace.stage)).not.toContain(
      'directory_created',
    )
    expect(traces.some((trace) => trace.diagnostic.status === 'corrupt')).toBe(
      false,
    )
    await journal.releaseClaim(claim!)
  })

  it('keeps a live owner active across wall-clock and timezone changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-clock-'))
    const journal = new GoalCleanupJournal(root)
    const claim = await journal.claim({
      receiptId: 'receipt_clock_shift',
      obligation: 'clear_active_run',
    })
    expect(claim).not.toBeNull()
    expect(
      journal.diagnoseClaim({
        receiptId: 'receipt_clock_shift',
        obligation: 'clear_active_run',
      }).status,
    ).toBe('active')

    const previousTimezone = process.env.TZ
    try {
      process.env.TZ = 'Pacific/Honolulu'
      vi.useFakeTimers()
      vi.setSystemTime(new Date(Date.now() + 48 * 60 * 60 * 1_000))
      expect(
        journal.diagnoseClaim({
          receiptId: 'receipt_clock_shift',
          obligation: 'clear_active_run',
        }).status,
      ).toBe('active')
    } finally {
      vi.useRealTimers()
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
      await journal.releaseClaim(claim!)
    }
  })

  it('keeps a live owner active across elapsed-time quantization boundaries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-elapsed-'))
    const journal = new GoalCleanupJournal(root)
    const claim = await journal.claim({
      receiptId: 'receipt_elapsed_boundary',
      obligation: 'emit_runtime_event',
    })
    expect(claim).not.toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 1_100))

    expect(
      journal.diagnoseClaim({
        receiptId: 'receipt_elapsed_boundary',
        obligation: 'emit_runtime_event',
      }).status,
    ).toBe('active')
    await journal.releaseClaim(claim!)
  })

  it('records boot/process-start identity and safely reclaims a reused PID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-owner-'))
    const journal = new GoalCleanupJournal(root)
    const first = await journal.claim({
      receiptId: 'receipt_pid_reuse',
      obligation: 'revoke_plan_tokens',
    })
    expect(first).not.toBeNull()
    const owner = JSON.parse(readFileSync(claimOwnerPath(first!.path), 'utf8'))
    expect(owner).toMatchObject({
      schemaVersion: 'cairn.goal.cleanup-claim.v4',
      pid: process.pid,
      receiptId: 'receipt_pid_reuse',
    })
    expect(owner.bootMarker).toMatch(/^[a-f0-9]{64}$/)
    expect(owner.processStartIdentity).toMatchObject({
      kind: expect.any(String),
    })
    expect(Number.isFinite(Date.parse(owner.leaseAcquiredAt))).toBe(true)
    await journal.releaseClaim(first!)

    mkdirSync(first!.path, { recursive: true })
    writeFileSync(
      join(first!.path, 'owner.json'),
      JSON.stringify({
        ...owner,
        schemaVersion: 'cairn.goal.cleanup-claim.v3',
        nonce: 'stale_pid_reuse_owner',
        processStartIdentity:
          owner.processStartIdentity.kind === 'darwin_boot_relative_interval'
            ? {
                ...owner.processStartIdentity,
                minSeconds: owner.processStartIdentity.maxSeconds + 100,
                maxSeconds: owner.processStartIdentity.maxSeconds + 101,
              }
            : { ...owner.processStartIdentity, value: '0'.repeat(64) },
      }),
    )
    expect(
      journal.diagnoseClaim({
        receiptId: 'receipt_pid_reuse',
        obligation: 'revoke_plan_tokens',
      }).status,
    ).toBe('pid_reused')

    const reclaimed = await journal.claim({
      receiptId: 'receipt_pid_reuse',
      obligation: 'revoke_plan_tokens',
    })
    expect(reclaimed).not.toBeNull()
    expect(reclaimed!.nonce).not.toBe('stale_pid_reuse_owner')
    await journal.releaseClaim(reclaimed!)
  })

  it('diagnoses and safely reclaims a dead legacy v3 directory claim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-legacy-v3-'))
    const journal = new GoalCleanupJournal(root)
    const seed = await journal.claim({
      receiptId: 'receipt_legacy_v3',
      obligation: 'clear_active_run',
    })
    const owner = JSON.parse(readFileSync(claimOwnerPath(seed!.path), 'utf8'))
    await journal.releaseClaim(seed!)
    mkdirSync(seed!.path, { recursive: true })
    writeFileSync(
      join(seed!.path, 'owner.json'),
      JSON.stringify({
        ...owner,
        schemaVersion: 'cairn.goal.cleanup-claim.v3',
        pid: 999_999_999,
        nonce: 'legacy_v3_dead',
      }),
    )

    expect(
      journal.diagnoseClaim({
        receiptId: 'receipt_legacy_v3',
        obligation: 'clear_active_run',
      }),
    ).toMatchObject({ status: 'dead', nonce: 'legacy_v3_dead' })
    const replacement = await journal.claim({
      receiptId: 'receipt_legacy_v3',
      obligation: 'clear_active_run',
    })
    expect(replacement).not.toBeNull()
    expect(lstatSync(replacement!.path).isFile()).toBe(true)
    await journal.releaseClaim(replacement!)
  })

  it('excludes a second stale reclaimer until the replacement live claim owns the path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-reclaim-race-'))
    const seedJournal = new GoalCleanupJournal(root)
    const seed = await seedJournal.claim({
      receiptId: 'receipt_reclaim_race',
      obligation: 'clear_active_run',
    })
    const owner = JSON.parse(readFileSync(claimOwnerPath(seed!.path), 'utf8'))
    await seedJournal.releaseClaim(seed!)
    mkdirSync(seed!.path, { recursive: true })
    writeFileSync(
      join(seed!.path, 'owner.json'),
      JSON.stringify({
        ...owner,
        schemaVersion: 'cairn.goal.cleanup-claim.v3',
        pid: 999_999_999,
        nonce: 'dead_cleanup_race_owner',
      }),
    )

    const competitor = new GoalCleanupJournal(root)
    let competingClaim: Promise<unknown> | null = null
    const winner = new GoalCleanupJournal(root, {
      beforeClaimRecoveryRemove: () => {
        competingClaim = competitor.claim({
          receiptId: 'receipt_reclaim_race',
          obligation: 'clear_active_run',
        })
      },
    })
    const replacement = await winner.claim({
      receiptId: 'receipt_reclaim_race',
      obligation: 'clear_active_run',
    })

    expect(await competingClaim).toBeNull()
    expect(replacement).not.toBeNull()
    expect(
      winner.diagnoseClaim({
        receiptId: 'receipt_reclaim_race',
        obligation: 'clear_active_run',
      }),
    ).toMatchObject({ status: 'active', nonce: replacement!.nonce })
    await winner.releaseClaim(replacement!)
  })

  it('retries safely when recovery crashes after marker publish but before intent persistence', async () => {
    const root = mkdtempSync(
      join(tmpdir(), 'cairn-cleanup-marker-before-intent-'),
    )
    const seedJournal = new GoalCleanupJournal(root)
    const seed = await seedJournal.claim({
      receiptId: 'receipt_marker_before_intent',
      obligation: 'clear_active_run',
    })
    const owner = JSON.parse(readFileSync(seed!.path, 'utf8'))
    await seedJournal.releaseClaim(seed!)
    writeFileSync(
      seed!.path,
      JSON.stringify({
        ...owner,
        pid: 999_999_999,
        nonce: 'dead_marker_before_intent',
      }),
    )

    const crashing = new GoalCleanupJournal(root, {
      afterClaimRecoveryMarkerPublish: () => {
        throw new Error('simulated crash before cleanup recovery intent')
      },
    })
    await expect(
      crashing.claim({
        receiptId: 'receipt_marker_before_intent',
        obligation: 'clear_active_run',
      }),
    ).resolves.toBeNull()
    expect(existsSync(`${seed!.path}.recovery`)).toBe(true)
    expect(existsSync(seed!.path)).toBe(true)

    const replacement = await new GoalCleanupJournal(root).claim({
      receiptId: 'receipt_marker_before_intent',
      obligation: 'clear_active_run',
    })
    expect(replacement).not.toBeNull()
    expect(existsSync(`${seed!.path}.recovery`)).toBe(false)
    await new GoalCleanupJournal(root).releaseClaim(replacement!)
  })

  it('resumes a stale recovery marker left before owner removal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-recovery-crash-'))
    const seedJournal = new GoalCleanupJournal(root)
    const seed = await seedJournal.claim({
      receiptId: 'receipt_recovery_crash',
      obligation: 'clear_active_run',
    })
    const owner = JSON.parse(readFileSync(claimOwnerPath(seed!.path), 'utf8'))
    await seedJournal.releaseClaim(seed!)
    mkdirSync(seed!.path, { recursive: true })
    writeFileSync(
      join(seed!.path, 'owner.json'),
      JSON.stringify({
        ...owner,
        schemaVersion: 'cairn.goal.cleanup-claim.v3',
        pid: 999_999_999,
        nonce: 'dead_cleanup_recovery_owner',
      }),
    )
    const crashing = new GoalCleanupJournal(root, {
      beforeClaimRecoveryRemove: () => {
        throw new Error('simulated cleanup recovery crash')
      },
    })
    await expect(
      crashing.claim({
        receiptId: 'receipt_recovery_crash',
        obligation: 'clear_active_run',
      }),
    ).resolves.toBeNull()

    const markerPath = `${seed!.path}.recovery`
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    const { integritySha256: _integritySha256, ...markerBase } = marker
    const staleMarkerBase = { ...markerBase, recoveryPid: 999_999_998 }
    writeFileSync(
      markerPath,
      JSON.stringify({
        ...staleMarkerBase,
        integritySha256: createHash('sha256')
          .update(canonicalJson(staleMarkerBase), 'utf8')
          .digest('hex'),
      }),
    )

    const recovered = await new GoalCleanupJournal(root).claim({
      receiptId: 'receipt_recovery_crash',
      obligation: 'clear_active_run',
    })
    expect(recovered).not.toBeNull()
    expect(recovered!.nonce).not.toBe('dead_cleanup_recovery_owner')
    expect(
      readdirSync(seedJournal.claimsDir).filter((name) =>
        name.includes('.recovery-intent-'),
      ),
    ).toEqual([])
    await new GoalCleanupJournal(root).releaseClaim(recovered!)
  })

  it('drops a stale old-generation marker before reclaiming a crashed replacement owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-double-crash-'))
    const journal = new GoalCleanupJournal(root)
    const seed = await journal.claim({
      receiptId: 'receipt_double_crash',
      obligation: 'clear_active_run',
    })
    const seedOwner = JSON.parse(
      readFileSync(claimOwnerPath(seed!.path), 'utf8'),
    )
    await journal.releaseClaim(seed!)
    mkdirSync(seed!.path, { recursive: true })
    writeFileSync(
      join(seed!.path, 'owner.json'),
      JSON.stringify({
        ...seedOwner,
        schemaVersion: 'cairn.goal.cleanup-claim.v3',
        pid: 999_999_999,
        nonce: 'dead_old_generation_owner',
      }),
    )
    const oldDiagnostic = journal.diagnoseClaim({
      receiptId: 'receipt_double_crash',
      obligation: 'clear_active_run',
    })
    const replacement = await journal.claim({
      receiptId: 'receipt_double_crash',
      obligation: 'clear_active_run',
    })
    const replacementOwner = JSON.parse(
      readFileSync(claimOwnerPath(replacement!.path), 'utf8'),
    )
    const currentIdentity = currentStableProcessIdentity()
    const markerBase = {
      schemaVersion: 'cairn.goal.cleanup-claim-recovery.v2',
      recoveryId: '1'.repeat(64),
      recoveryNonce: 'stale_old_generation_marker',
      label: 'dead',
      expectedStatus: oldDiagnostic.status,
      expectedNonce: oldDiagnostic.nonce,
      expectedOwnerSha256: oldDiagnostic.ownerSha256,
      expectedPathIdentitySha256: oldDiagnostic.pathIdentitySha256,
      recoveryPid: 999_999_998,
      recoveryHostname: hostname(),
      recoveryBootMarker: currentIdentity.bootMarker,
      recoveryProcessStartIdentity: currentIdentity.processStartIdentity,
    }
    writeFileSync(
      `${replacement!.path}.recovery`,
      JSON.stringify({
        ...markerBase,
        integritySha256: createHash('sha256')
          .update(canonicalJson(markerBase), 'utf8')
          .digest('hex'),
      }),
    )
    writeFileSync(
      replacement!.path,
      JSON.stringify({
        ...replacementOwner,
        pid: 999_999_997,
        nonce: 'dead_replacement_owner',
      }),
    )

    const recovered = await new GoalCleanupJournal(root).claim({
      receiptId: 'receipt_double_crash',
      obligation: 'clear_active_run',
    })
    expect(recovered).not.toBeNull()
    expect(recovered!.nonce).not.toBe('dead_replacement_owner')
    await new GoalCleanupJournal(root).releaseClaim(recovered!)
  })

  it('keeps an ambiguous live legacy owner until explicit nonce-confirmed recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-ambiguous-'))
    const journal = new GoalCleanupJournal(root)
    const seed = await journal.claim({
      receiptId: 'receipt_ambiguous_owner',
      obligation: 'emit_runtime_event',
    })
    const owner = JSON.parse(readFileSync(claimOwnerPath(seed!.path), 'utf8'))
    await journal.releaseClaim(seed!)
    mkdirSync(seed!.path, { recursive: true })
    writeFileSync(
      join(seed!.path, 'owner.json'),
      JSON.stringify({
        schemaVersion: 'cairn.goal.cleanup-claim.v1',
        pid: process.pid,
        hostname: owner.hostname,
        nonce: 'legacy_ambiguous_nonce',
        receiptId: 'receipt_ambiguous_owner',
        obligation: 'emit_runtime_event',
      }),
    )

    await expect(
      journal.claim({
        receiptId: 'receipt_ambiguous_owner',
        obligation: 'emit_runtime_event',
      }),
    ).resolves.toBeNull()
    expect(existsSync(seed!.path)).toBe(true)
    expect(
      journal.diagnoseClaim({
        receiptId: 'receipt_ambiguous_owner',
        obligation: 'emit_runtime_event',
      }),
    ).toMatchObject({
      status: 'ambiguous',
      nonce: 'legacy_ambiguous_nonce',
    })
    expect(
      journal.recoverAmbiguousClaim({
        receiptId: 'receipt_ambiguous_owner',
        obligation: 'emit_runtime_event',
        expectedNonce: 'wrong_nonce',
        confirmedOwnerStale: true,
      }),
    ).toBe(false)
    expect(
      journal.recoverAmbiguousClaim({
        receiptId: 'receipt_ambiguous_owner',
        obligation: 'emit_runtime_event',
        expectedNonce: 'legacy_ambiguous_nonce',
        confirmedOwnerStale: true,
      }),
    ).toBe(true)
    await expect(
      journal.claim({
        receiptId: 'receipt_ambiguous_owner',
        obligation: 'emit_runtime_event',
      }),
    ).resolves.not.toBeNull()
  })

  it('keeps a dead legacy owner fail-closed until explicit nonce-confirmed recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-dead-legacy-'))
    const journal = new GoalCleanupJournal(root)
    const seed = await journal.claim({
      receiptId: 'receipt_dead_legacy_owner',
      obligation: 'emit_runtime_event',
    })
    const owner = JSON.parse(readFileSync(claimOwnerPath(seed!.path), 'utf8'))
    await journal.releaseClaim(seed!)
    mkdirSync(seed!.path, { recursive: true })
    writeFileSync(
      join(seed!.path, 'owner.json'),
      JSON.stringify({
        schemaVersion: 'cairn.goal.cleanup-claim.v1',
        pid: 999_999_999,
        hostname: owner.hostname,
        nonce: 'dead_legacy_nonce',
        receiptId: 'receipt_dead_legacy_owner',
        obligation: 'emit_runtime_event',
      }),
    )

    expect(
      journal.diagnoseClaim({
        receiptId: 'receipt_dead_legacy_owner',
        obligation: 'emit_runtime_event',
      }),
    ).toMatchObject({ status: 'ambiguous', nonce: 'dead_legacy_nonce' })
    await expect(
      journal.claim({
        receiptId: 'receipt_dead_legacy_owner',
        obligation: 'emit_runtime_event',
      }),
    ).resolves.toBeNull()
    expect(
      journal.recoverAmbiguousClaim({
        receiptId: 'receipt_dead_legacy_owner',
        obligation: 'emit_runtime_event',
        expectedNonce: 'dead_legacy_nonce',
        confirmedOwnerStale: true,
      }),
    ).toBe(true)
  })

  it('keeps a corrupt claim fail-closed until explicit corrupt recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-corrupt-'))
    const journal = new GoalCleanupJournal(root)
    const seed = await journal.claim({
      receiptId: 'receipt_corrupt_owner',
      obligation: 'clear_pending_interaction',
    })
    await journal.releaseClaim(seed!)
    mkdirSync(seed!.path, { recursive: true })
    writeFileSync(join(seed!.path, 'owner.json'), '{corrupt owner', 'utf8')

    const corruptDiagnostic = journal.diagnoseClaim({
      receiptId: 'receipt_corrupt_owner',
      obligation: 'clear_pending_interaction',
    })
    expect(corruptDiagnostic.status).toBe('corrupt')
    await expect(
      journal.claim({
        receiptId: 'receipt_corrupt_owner',
        obligation: 'clear_pending_interaction',
      }),
    ).resolves.toBeNull()
    expect(
      journal.recoverCorruptClaim({
        receiptId: 'receipt_corrupt_owner',
        obligation: 'clear_pending_interaction',
        expectedPathIdentitySha256: corruptDiagnostic.pathIdentitySha256!,
        confirmedCorrupt: true,
      }),
    ).toBe(true)
    const recovered = await journal.claim({
      receiptId: 'receipt_corrupt_owner',
      obligation: 'clear_pending_interaction',
    })
    expect(recovered).not.toBeNull()
    await journal.releaseClaim(recovered!)
  })

  it('does not replace an empty corrupt claim directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-empty-'))
    const journal = new GoalCleanupJournal(root)
    const seed = await journal.claim({
      receiptId: 'receipt_empty_owner',
      obligation: 'clear_pending_interaction',
    })
    await journal.releaseClaim(seed!)
    mkdirSync(seed!.path, { recursive: true })

    const emptyDiagnostic = journal.diagnoseClaim({
      receiptId: 'receipt_empty_owner',
      obligation: 'clear_pending_interaction',
    })
    expect(emptyDiagnostic.status).toBe('corrupt')
    await expect(
      journal.claim({
        receiptId: 'receipt_empty_owner',
        obligation: 'clear_pending_interaction',
      }),
    ).resolves.toBeNull()
    expect(existsSync(seed!.path)).toBe(true)
    expect(existsSync(join(seed!.path, 'owner.json'))).toBe(false)
    expect(
      journal.recoverCorruptClaim({
        receiptId: 'receipt_empty_owner',
        obligation: 'clear_pending_interaction',
        expectedPathIdentitySha256: emptyDiagnostic.pathIdentitySha256!,
        confirmedCorrupt: true,
      }),
    ).toBe(true)
  })
})

describe('GoalCleanupJournal acknowledgement recovery', () => {
  it('repairs an exact partial tail only from its durable acknowledgement intent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-ack-intent-'))
    let intentPath = ''
    const crashing = new GoalCleanupJournal(root, {
      afterAckIntentPersisted(context) {
        intentPath = context.intentPath
        writeFileSync(context.journalPath, context.record.slice(0, -5), {
          encoding: 'utf8',
          flag: 'a',
        })
        throw new Error('simulated partial acknowledgement append')
      },
    })
    await expect(
      crashing.acknowledge({
        goalId: 'goal_ack_intent',
        receiptId: 'receipt_ack_intent',
        obligation: 'revoke_plan_tokens',
        acknowledgedAt: '2026-07-16T02:00:00.000Z',
      }),
    ).rejects.toThrow('simulated partial')
    expect(existsSync(intentPath)).toBe(true)

    const inspected = await new GoalCleanupJournal(root).inspect()
    expect(inspected.issue).toBeNull()
    expect(inspected.acknowledgements).toHaveLength(1)
    expect(existsSync(intentPath)).toBe(false)
    await expect(new GoalCleanupJournal(root).inspect()).resolves.toMatchObject(
      {
        issue: null,
        acknowledgements: [{ receiptId: 'receipt_ack_intent' }],
      },
    )
  })

  it('does not repair a partial tail that differs from its exact durable intent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-ack-mismatch-'))
    let journalPath = ''
    const crashing = new GoalCleanupJournal(root, {
      afterAckIntentPersisted(context) {
        journalPath = context.journalPath
        writeFileSync(context.journalPath, `${context.record.slice(0, 8)}X`, {
          encoding: 'utf8',
          flag: 'a',
        })
        throw new Error('simulated mismatched partial append')
      },
    })
    await expect(
      crashing.acknowledge({
        goalId: 'goal_ack_mismatch',
        receiptId: 'receipt_ack_mismatch',
        obligation: 'clear_active_run',
        acknowledgedAt: '2026-07-16T02:00:00.000Z',
      }),
    ).rejects.toThrow('simulated mismatched')
    const before = readFileSync(journalPath, 'utf8')

    await expect(new GoalCleanupJournal(root).inspect()).resolves.toMatchObject(
      {
        acknowledgements: [],
        issue: { code: 'goal_cleanup_journal_corrupt' },
      },
    )
    expect(readFileSync(journalPath, 'utf8')).toBe(before)
  })

  it('clears the durable intent after a complete append and readback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-ack-complete-'))
    let intentPath = ''
    const journal = new GoalCleanupJournal(root, {
      afterAckIntentPersisted(context) {
        intentPath = context.intentPath
      },
    })
    await journal.acknowledge({
      goalId: 'goal_ack_complete',
      receiptId: 'receipt_ack_complete',
      obligation: 'emit_runtime_event',
      acknowledgedAt: '2026-07-16T02:00:00.000Z',
    })

    expect(intentPath).not.toBe('')
    expect(existsSync(intentPath)).toBe(false)
    await expect(new GoalCleanupJournal(root).inspect()).resolves.toMatchObject(
      {
        issue: null,
        acknowledgements: [{ receiptId: 'receipt_ack_complete' }],
      },
    )
  })

  it('keeps the intent if interrupted after the journal directory is durable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-ack-order-'))
    let intentPath = ''
    const crashing = new GoalCleanupJournal(root, {
      afterAckIntentPersisted(context) {
        intentPath = context.intentPath
      },
      afterAckJournalDirectorySync() {
        throw new Error('simulated crash before intent removal')
      },
    })
    await expect(
      crashing.acknowledge({
        goalId: 'goal_ack_order',
        receiptId: 'receipt_ack_order',
        obligation: 'clear_pending_interaction',
        acknowledgedAt: '2026-07-16T02:00:00.000Z',
      }),
    ).rejects.toThrow('simulated crash')
    expect(existsSync(crashing.path)).toBe(true)
    expect(existsSync(intentPath)).toBe(true)

    await expect(new GoalCleanupJournal(root).inspect()).resolves.toMatchObject(
      {
        issue: null,
        acknowledgements: [{ receiptId: 'receipt_ack_order' }],
      },
    )
    expect(existsSync(intentPath)).toBe(false)
  })

  it('fails closed on a partial acknowledgement tail without an exact intent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-cleanup-ack-no-intent-'))
    const journal = new GoalCleanupJournal(root)
    mkdirSync(join(root, 'goals'), { recursive: true })
    writeFileSync(journal.path, '{"partial":', 'utf8')

    await expect(journal.inspect()).resolves.toMatchObject({
      acknowledgements: [],
      issue: { code: 'goal_cleanup_journal_corrupt' },
    })
    expect(readFileSync(journal.path, 'utf8')).toBe('{"partial":')
  })
})

function claimOwnerPath(path: string): string {
  return lstatSync(path).isDirectory() ? join(path, 'owner.json') : path
}
