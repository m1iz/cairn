export type PromptSectionOwner =
  | 'core'
  | 'agent_role'
  | 'mode'
  | 'plan'
  | 'goal'
  | 'project'
  | 'memory'
  | 'default'
  | 'tool'
  | 'user_append'

export interface PromptSectionInput {
  name: string
  content: string
  source: string
  priority: number
  budgetChars: number | null
  version: string | null
  scope?: string | null
  stability?: 'stable' | 'dynamic'
  owner?: PromptSectionOwner
  ruleIds?: string[]
}
