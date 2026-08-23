import type { ContextSection } from '../agent/context-builder'
import type { PromptContextPlan } from '../prompts/manifest'
import type { ContextDecision, ContextFragment } from '../v2/contracts/context'
import { ContextAssemblerV2 } from '../v2/context/context-assembler'

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
    const result = new ContextAssemblerV2().assemble({
      fragments: input.sections.map(toFragment),
      decisions: input.contextPlan?.items.map(toDecision) ?? null,
      omissions: input.contextPlan?.omitted,
    })
    return {
      prompt: result.prompt,
      rendered: result.rendered.map(toCompatibilityEntry),
      omitted: result.omitted.map(toCompatibilityEntry),
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

function toFragment(section: ContextSection): ContextFragment {
  return {
    id: sectionId(section.name),
    kind: section.name,
    source: section.source,
    content: section.content,
  }
}

function toDecision(item: PromptContextPlan['items'][number]): ContextDecision {
  return {
    id: item.id,
    kind: item.kind,
    source: item.source,
    action: item.action,
    reason: item.reason,
  }
}

function toCompatibilityEntry(
  entry: import('../v2/contracts/context').ContextAssemblyEntry,
): ContextAssemblyEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    source: entry.source,
    reason: entry.reason,
    ...(entry.fragmentId
      ? { sectionName: entry.fragmentId.replace(/^section:/, '') }
      : {}),
  }
}
