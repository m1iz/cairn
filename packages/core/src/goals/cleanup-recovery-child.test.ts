import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createAuthorizedGoalCompletionGate } from '../agent/goal-completion-gate-internal'
import { GoalBlockerFactStore } from './blocker-facts'
import { GoalGateFactStore } from './gate-facts'
import { GoalStore } from './store'

const enabled = process.env.CAIRN_CLEANUP_CHILD === '1'

describe.runIf(enabled)('Goal cleanup child process', () => {
  it('recovers the shared pending obligation', async () => {
    const root = process.env.CAIRN_CLEANUP_ROOT!
    const ready = process.env.CAIRN_CLEANUP_READY!
    const go = process.env.CAIRN_CLEANUP_GO!
    const counter = process.env.CAIRN_CLEANUP_COUNTER!
    const tracePath = process.env.CAIRN_CLEANUP_TRACE
    writeFileSync(ready, 'ready')
    while (!existsSync(go))
      await new Promise((resolve) => setTimeout(resolve, 10))

    const store = new GoalStore(root)
    const gate = createAuthorizedGoalCompletionGate({
      goalStore: store,
      planBridge: {
        async planCompletionReceipt() {
          return null
        },
      } as never,
      evidenceLedger: {
        async validatedEvidenceById() {
          return null
        },
      },
      reviewerLedger: {
        async latestReviewerDecision() {
          return null
        },
      },
      factStore: new GoalGateFactStore(root),
      blockerFactStore: new GoalBlockerFactStore(root),
      cleanup: {
        async revokePlanTokens() {
          appendFileSync(counter, `${process.pid}\n`, 'utf8')
          await new Promise((resolve) => setTimeout(resolve, 50))
        },
      },
      onCleanupClaimTrace: tracePath
        ? (trace) =>
            appendFileSync(tracePath, `${JSON.stringify(trace)}\n`, 'utf8')
        : undefined,
    })
    const result = await gate.recoverPostCommitCleanup()
    expect(result.failed).toBe(0)
  })
})
