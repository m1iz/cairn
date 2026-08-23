import type {
  AssistantMessage,
  GoalProjectionState,
  RuntimeGoalSummary,
  SubagentState,
  ToolSegment,
} from '../types'

export function goalById(
  projection: GoalProjectionState,
  goalId: string,
): RuntimeGoalSummary | null {
  return projection.byId[goalId] || null
}

export function activeGoalForSession(
  projection: GoalProjectionState,
  sessionId: string,
): RuntimeGoalSummary | null {
  const goalId = projection.activeBySession[sessionId]
  return goalId ? goalById(projection, goalId) : null
}

export function findToolSegment(
  assistant: AssistantMessage | null | undefined,
  id: string | undefined,
): ToolSegment | null {
  if (!assistant || !id) return null
  return (
    assistant.segments.find(
      (seg): seg is ToolSegment => seg.type === 'tool' && seg.toolId === id,
    ) || null
  )
}

export function findSubagent(
  assistant: AssistantMessage | null | undefined,
  parentId: string | undefined,
  subagentId: string | undefined,
): SubagentState | null {
  const seg = findToolSegment(assistant, parentId)
  if (!seg || !subagentId) return null
  return (seg.subagents || []).find((item) => item.id === subagentId) || null
}

export function findSubagentTool(
  assistant: AssistantMessage | null | undefined,
  parentId: string | undefined,
  subagentId: string | undefined,
  toolId: string | undefined,
) {
  const subagent = findSubagent(assistant, parentId, subagentId)
  if (!subagent || !toolId) return null
  return (subagent.tools || []).find((tool) => tool.id === toolId) || null
}
