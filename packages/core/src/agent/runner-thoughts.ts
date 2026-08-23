/**
 * 工具调用意图/结果的展示态 "audit thought" 摘要 (audit P1-6)。
 * 从 AgentRunner.stepAsync 抽出——这部分是纯展示逻辑（生成给用户看的一句话摘要），
 * 和回合状态机本身（模型调用/工具调度/暂停恢复）无关，拆到独立模块降低 stepAsync 的体量。
 */
import type { ToolCallRequest } from '../providers/base'
import { ToolResultObj } from '../tools/base'
import * as runtimeEvents from './runtime-events'
import { summarizeToolResult } from './runner-helpers'

export function toolIntentThought(
  toolCalls: ToolCallRequest[],
): Record<string, unknown> {
  return runtimeEvents.agentThought({
    stage: 'tool_intent',
    label: '思考参考',
    summary: toolIntentSummary(toolCalls),
    source: 'audit',
    status: 'done',
    toolCallIds: toolCalls.map((call) => call.id),
    toolNames: toolCalls.map((call) => call.name),
  })
}

export function toolResultSummaryThought(
  toolCalls: ToolCallRequest[],
  resultsById: Map<string, ToolResultObj>,
): Record<string, unknown> | null {
  const summary = toolResultSummary(toolCalls, resultsById)
  if (!summary) return null
  return runtimeEvents.agentThought({
    stage: 'tool_result_summary',
    label: '思考参考',
    summary,
    source: 'audit',
    status: 'done',
    toolCallIds: toolCalls.map((call) => call.id),
    toolNames: toolCalls.map((call) => call.name),
  })
}

function toolIntentSummary(toolCalls: ToolCallRequest[]): string {
  if (!toolCalls.length) return '没有需要执行的工具。'
  const names = uniqueToolNames(toolCalls)
  const target = names.length === 1 ? names[0]! : names.join('、')
  const purpose = toolPurposeSummary(toolCalls)
  return `准备调用 ${target}，${purpose}。`
}

function toolResultSummary(
  toolCalls: ToolCallRequest[],
  resultsById: Map<string, ToolResultObj>,
): string {
  const parts = toolCalls.flatMap((call) => {
    const result = resultsById.get(call.id)
    if (!result) return [`${call.name} 未返回结果`]
    const mediaCount = result.artifacts.filter(
      (artifact) => artifact.media?.kind === 'image',
    ).length
    if (!result.isError && !mediaCount) return []
    if (result.isError) {
      const summary = summarizeToolResult(result.summary, 80)
      return [`${call.name} 失败${summary ? `：${summary}` : ''}`]
    }
    return [`${call.name} 成功，识别到 ${mediaCount} 个图片 artifact`]
  })
  return parts.join('；')
}

function uniqueToolNames(toolCalls: ToolCallRequest[]): string[] {
  const out: string[] = []
  for (const call of toolCalls) {
    if (!out.includes(call.name)) out.push(call.name)
  }
  return out
}

function toolPurposeSummary(toolCalls: ToolCallRequest[]): string {
  if (toolCalls.some((call) => callLooksLikeImageCheck(call)))
    return '先确认图片路径、格式和大小'
  if (
    toolCalls.some(
      (call) =>
        call.name === 'read_file' ||
        call.name === 'grep' ||
        call.name === 'glob',
    )
  )
    return '先收集和核对项目上下文'
  if (toolCalls.some((call) => call.name === 'run_command'))
    return '先通过命令获取运行证据'
  if (
    toolCalls.some(
      (call) => call.name === 'write_file' || call.name === 'edit_file',
    )
  )
    return '按当前计划修改目标文件'
  if (toolCalls.some((call) => call.name === 'update_todos'))
    return '同步当前任务进度'
  if (toolCalls.some((call) => call.name === 'dispatch_subagent'))
    return '派遣独立任务获取复核或执行结果'
  return '获取下一步判断所需证据'
}

function callLooksLikeImageCheck(call: ToolCallRequest): boolean {
  const text = JSON.stringify(call.arguments ?? {}).toLowerCase()
  if (!/\.(png|jpe?g|webp|gif)\b/.test(text)) return false
  return (
    call.name === 'read_file' ||
    call.name === 'run_command' ||
    call.name === 'write_file'
  )
}
