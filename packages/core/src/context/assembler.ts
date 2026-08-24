import type { ContextSection } from '../agent/context-builder'
import type { PromptContextPlan } from '../prompts/manifest'

export interface ContextAssemblyInput {
  sections: ContextSection[]
  contextPlan?: PromptContextPlan | null
}

export interface ContextAssemblyEntry {
  id: string
  kind: string
  source: string
  reason: string
  sectionName?: string
}

export interface ContextAssembly {
  prompt: string
  rendered: ContextAssemblyEntry[]
  omitted: ContextAssemblyEntry[]
}

export class ContextAssembler {
  assemble(input: ContextAssemblyInput): ContextAssembly {
    const sectionsById = new Map(
      input.sections.map((section) => [sectionId(section.name), section]),
    )
    const included: ContextSection[] = []
    const rendered: ContextAssemblyEntry[] = []
    const omitted: ContextAssemblyEntry[] = []

    if (input.contextPlan) {
      const plannedIds = new Set<string>()
      for (const item of input.contextPlan.items) {
        plannedIds.add(item.id)
        const section = sectionsById.get(item.id)
        const entry: ContextAssemblyEntry = {
          id: item.id,
          kind: item.kind,
          source: section?.source ?? item.source,
          reason: item.reason,
          ...(section ? { sectionName: section.name } : {}),
        }
        if (item.action === 'include') {
          if (section) included.push(section)
          rendered.push(entry)
        } else {
          omitted.push(entry)
        }
      }

      for (const section of input.sections) {
        const id = sectionId(section.name)
        if (!plannedIds.has(id)) {
          omitted.push({
            id,
            kind: section.name,
            source: section.source,
            reason: 'not_in_context_plan',
            sectionName: section.name,
          })
        }
      }

      for (const omission of input.contextPlan.omitted) {
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
      for (const section of input.sections) {
        included.push(section)
        rendered.push({
          id: sectionId(section.name),
          kind: section.name,
          source: section.source,
          reason: 'included_without_context_plan',
          sectionName: section.name,
        })
      }
    }

    return {
      prompt: included.map((section) => section.content).join('\n\n---\n\n'),
      rendered,
      omitted,
    }
  }

  renderSystemPrompt(
    sections: ContextSection[],
    contextPlan?: PromptContextPlan | null,
  ): string {
    return this.assemble({ sections, contextPlan }).prompt
  }
}

function sectionId(name: string): string {
  return `section:${name}`
}
