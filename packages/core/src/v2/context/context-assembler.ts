import type {
  ContextAssemblyEntry,
  ContextAssemblyResult,
  ContextDecision,
  ContextFragment,
  ContextOmission,
} from '../contracts/context'

export interface AssembleContextInput {
  fragments: readonly ContextFragment[]
  decisions?: readonly ContextDecision[] | null
  omissions?: readonly ContextOmission[]
}

export class ContextAssemblerV2 {
  assemble(input: AssembleContextInput): ContextAssemblyResult {
    const fragmentsById = new Map(
      input.fragments.map((fragment) => [fragment.id, fragment]),
    )
    const included: ContextFragment[] = []
    const rendered: ContextAssemblyEntry[] = []
    const omitted: ContextAssemblyEntry[] = []

    if (input.decisions) {
      const plannedIds = new Set<string>()
      for (const decision of input.decisions) {
        plannedIds.add(decision.id)
        const fragment = fragmentsById.get(decision.id)
        const entry = entryFor(decision, fragment)
        if (decision.action === 'include') {
          if (fragment) included.push(fragment)
          rendered.push(entry)
        } else {
          omitted.push(entry)
        }
      }
      for (const fragment of input.fragments) {
        if (!plannedIds.has(fragment.id)) {
          omitted.push({
            id: fragment.id,
            kind: fragment.kind,
            source: fragment.source,
            reason: 'not_in_context_plan',
            fragmentId: fragment.id,
          })
        }
      }
      for (const omission of input.omissions ?? []) {
        if (
          !omitted.some(
            (entry) =>
              entry.kind === omission.kind &&
              entry.source === omission.source &&
              entry.reason === omission.reason,
          )
        ) {
          omitted.push({
            id: `omitted:${omission.kind}:${omission.source}`,
            ...omission,
          })
        }
      }
    } else {
      for (const fragment of input.fragments) {
        included.push(fragment)
        rendered.push({
          id: fragment.id,
          kind: fragment.kind,
          source: fragment.source,
          reason: 'included_without_context_plan',
          fragmentId: fragment.id,
        })
      }
    }

    return {
      prompt: included.map((fragment) => fragment.content).join('\n\n---\n\n'),
      rendered,
      omitted,
    }
  }
}

function entryFor(
  decision: ContextDecision,
  fragment: ContextFragment | undefined,
): ContextAssemblyEntry {
  return {
    id: decision.id,
    kind: decision.kind,
    source: fragment?.source ?? decision.source,
    reason: decision.reason,
    ...(fragment ? { fragmentId: fragment.id } : {}),
  }
}
