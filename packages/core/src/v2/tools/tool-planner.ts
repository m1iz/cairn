import type { ToolIntent } from '../contracts/tool'

export interface ToolExecutionBatch {
  mode: 'parallel' | 'exclusive'
  calls: readonly ToolIntent[]
}

export function planToolExecution(
  intents: readonly ToolIntent[],
): ToolExecutionBatch[] {
  const batches: ToolExecutionBatch[] = []
  const ids = new Set<string>()
  let parallel: ToolIntent[] = []

  const flushParallel = () => {
    if (!parallel.length) return
    batches.push({ mode: 'parallel', calls: parallel })
    parallel = []
  }

  for (const intent of intents) {
    if (ids.has(intent.id))
      throw new Error(`duplicate tool call id: ${intent.id}`)
    ids.add(intent.id)
    const frozen = cloneIntent(intent)
    if (frozen.concurrencySafe) {
      parallel.push(frozen)
      continue
    }
    flushParallel()
    batches.push({ mode: 'exclusive', calls: [frozen] })
  }
  flushParallel()
  return batches
}

function cloneIntent(intent: ToolIntent): ToolIntent {
  return {
    id: intent.id,
    name: intent.name,
    arguments: structuredClone(intent.arguments),
    concurrencySafe: intent.concurrencySafe,
  }
}
