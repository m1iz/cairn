import { GoalMutationGuard } from './mutation-guard'

const root = process.env.CAIRN_MUTATION_ROOT
const serialized = process.env.CAIRN_MUTATION_RECOVERY_INPUT
if (!root || !serialized) process.exit(2)

const crashPhase = process.env.CAIRN_MUTATION_CRASH_PHASE
new GoalMutationGuard(
  root,
  crashPhase === 'operator-reclaimer'
    ? { afterOperatorReclaimClaimed: () => process.exit(92) }
    : { afterOperatorRecoveryClaim: () => process.exit(91) },
).recoverStaleMarker(JSON.parse(serialized))
process.exit(3)
