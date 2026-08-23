import { existsSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GoalGateMutationLedger } from './mutation-ledger'
import { GoalMutationGuard } from './mutation-guard'
import { PlanStore } from '../plans/store'

describe('mutation ledger child process fixture', () => {
  it.skipIf(process.env.CAIRN_MUTATION_CHILD !== '1')(
    'executes one requested cross-process mutation scenario',
    async () => {
      const root = process.env.CAIRN_MUTATION_ROOT!
      const operation = process.env.CAIRN_MUTATION_OPERATION!
      const ledger = new GoalGateMutationLedger(root)
      if (operation === 'loop') {
        writeFileSync(process.env.CAIRN_MUTATION_READY!, 'ready')
        while (!existsSync(process.env.CAIRN_MUTATION_GO!))
          await new Promise((resolve) => setTimeout(resolve, 2))
        const prefix = process.env.CAIRN_MUTATION_PREFIX!
        const count = Number(process.env.CAIRN_MUTATION_COUNT ?? 1)
        for (let index = 0; index < count; index += 1)
          ledger.record('runtime', `${prefix}:${index}`)
      } else if (operation === 'plan-store') {
        new PlanStore(root)
      } else if (operation === 'recover-marker') {
        writeFileSync(process.env.CAIRN_MUTATION_READY!, 'ready')
        while (!existsSync(process.env.CAIRN_MUTATION_GO!))
          await new Promise((resolve) => setTimeout(resolve, 2))
        const input = JSON.parse(process.env.CAIRN_MUTATION_RECOVERY_INPUT!)
        writeFileSync(
          process.env.CAIRN_MUTATION_RESULT!,
          String(new GoalMutationGuard(root).recoverStaleMarker(input)),
        )
      } else {
        ledger.record('runtime', 'child:terminal-race')
      }
      expect(true).toBe(true)
    },
  )
})
