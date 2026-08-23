import type { CoreOperationResult } from '@cairn/core'

export type EnvironmentStatusPayload =
  CoreOperationResult<'environment.getStatus'>
export type EnvironmentInstallPlan =
  CoreOperationResult<'environment.createInstallPlan'>
export type EnvironmentJob = CoreOperationResult<'environment.install'>
export type EnvironmentLogPage =
  CoreOperationResult<'environment.getInstallLog'>
export type EnvironmentTool =
  EnvironmentStatusPayload['status']['tools'][number]

export type EnvironmentTone = 'ok' | 'warn' | 'error' | 'muted' | 'running'

export interface EnvironmentToolSection {
  id: EnvironmentTool['category']
  title: string
  tools: EnvironmentTool[]
}

export interface EnvironmentPlanStepReview {
  stepId: string
  toolId: EnvironmentTool['id']
  displayName: string
  version: string
  strategy: string
  sourceUrl: string
  publisher: string
  estimatedBytes: number
  requiresElevation: boolean
  requiresSeparateConfirmation: boolean
  cancellable: boolean
  licenseId: string
}

export interface EnvironmentErrorPresentation {
  title: string
  action: string
}

const CATEGORY_ORDER: EnvironmentTool['category'][] = [
  'base',
  'project',
  'skill',
  'large-prerequisite',
]

const CATEGORY_LABELS: Record<EnvironmentTool['category'], string> = {
  base: '基础工具',
  project: '当前项目',
  skill: 'Skill 依赖',
  'large-prerequisite': '大型依赖',
}

const ERROR_PRESENTATIONS: Record<string, EnvironmentErrorPresentation> = {
  catalog_invalid: {
    title: '内置环境工具目录校验失败',
    action: '重新安装当前版本',
  },
  unsupported_platform: {
    title: '当前系统暂不支持自动配置',
    action: '查看系统要求',
  },
  unsupported_arch: {
    title: '当前处理器架构暂不支持',
    action: '查看系统要求',
  },
  unsupported_requirement: {
    title: '项目版本要求无法安全解析',
    action: '检查项目声明',
  },
  plan_stale: { title: '安装计划已经过期', action: '刷新并重新生成' },
  job_active: { title: '已有安装任务正在运行', action: '查看当前任务' },
  confirmation_required: {
    title: '仍需确认高风险安装步骤',
    action: '返回确认页',
  },
  license_not_accepted: {
    title: '尚未接受全部许可协议',
    action: '检查许可协议',
  },
  network_unavailable: { title: '网络不可用', action: '检查网络后重试' },
  proxy_failed: { title: '代理连接失败', action: '检查代理后重试' },
  disk_space_insufficient: {
    title: '磁盘空间不足',
    action: '释放空间后重试',
  },
  download_failed: { title: '安装资源下载失败', action: '重试下载' },
  redirect_blocked: {
    title: '下载地址发生不受信任的跳转',
    action: '停止并报告问题',
  },
  integrity_failed: {
    title: '安装资源完整性校验失败',
    action: '重新下载',
  },
  publisher_mismatch: {
    title: '安装程序发布者不匹配',
    action: '停止并报告问题',
  },
  elevation_declined: {
    title: '系统授权已取消',
    action: '确认后重试',
  },
  installer_failed: { title: '安装程序执行失败', action: '查看日志' },
  post_install_probe_failed: {
    title: '安装后仍未检测到所需版本',
    action: '重新检测环境',
  },
  cancelled: { title: '安装任务已取消', action: '查看部分结果' },
  interrupted: { title: '上次安装被应用退出中断', action: '重新检测环境' },
}

export function environmentToolSections(
  payload: EnvironmentStatusPayload | null | undefined,
): EnvironmentToolSection[] {
  if (!payload) return []
  return CATEGORY_ORDER.map((id) => ({
    id,
    title: CATEGORY_LABELS[id],
    tools: payload.status.tools.filter((tool) => tool.category === id),
  })).filter((section) => section.tools.length)
}

export function installableEnvironmentToolIds(
  payload: EnvironmentStatusPayload | null | undefined,
): EnvironmentTool['id'][] {
  if (!payload) return []
  return payload.status.tools
    .filter(
      (tool) =>
        tool.required &&
        (tool.status === 'missing' || tool.status === 'version_mismatch') &&
        Boolean(tool.installStrategy),
    )
    .map((tool) => tool.id)
}

export function environmentToolTone(
  status: EnvironmentTool['status'],
): EnvironmentTone {
  if (status === 'ready') return 'ok'
  if (status === 'installing' || status === 'awaiting_user') return 'running'
  if (status === 'failed' || status === 'blocked') return 'error'
  if (status === 'missing' || status === 'version_mismatch') return 'warn'
  return 'muted'
}

export function environmentToolStatusLabel(
  status: EnvironmentTool['status'],
): string {
  const labels: Record<EnvironmentTool['status'], string> = {
    ready: '已就绪',
    missing: '缺失',
    version_mismatch: '版本不匹配',
    installing: '安装中',
    awaiting_user: '等待系统确认',
    failed: '失败',
    unsupported: '不支持',
    blocked: '被阻止',
  }
  return labels[status]
}

export function environmentJobStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    planned: '待开始',
    running: '安装中',
    awaiting_user: '等待系统确认',
    cancelling: '正在取消',
    completed: '已完成',
    partial: '部分完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
  }
  return labels[status] || status || '未知'
}

export function environmentJobTone(status: string): EnvironmentTone {
  if (status === 'completed') return 'ok'
  if (['running', 'planned', 'cancelling', 'awaiting_user'].includes(status))
    return 'running'
  if (status === 'partial' || status === 'cancelled') return 'warn'
  if (status === 'failed' || status === 'interrupted') return 'error'
  return 'muted'
}

export function environmentPlanReview(
  plan: EnvironmentInstallPlan,
  payload: EnvironmentStatusPayload,
): EnvironmentPlanStepReview[] {
  const tools = new Map(payload.catalog.tools.map((tool) => [tool.id, tool]))
  return plan.steps.map((step) => {
    const tool = tools.get(step.toolId)
    const strategy = tool?.strategies.find(
      (candidate) => candidate.id === step.strategyId,
    )
    return {
      stepId: step.stepId,
      toolId: step.toolId,
      displayName: tool?.displayName || step.toolId,
      version: tool?.pinnedVersion || '',
      strategy: strategy?.kind || step.strategyId,
      sourceUrl: strategy?.sourceUrl || '',
      publisher: strategy?.publisher || '',
      estimatedBytes: strategy?.estimatedBytes || 0,
      requiresElevation: step.requiresElevation,
      requiresSeparateConfirmation: step.requiresSeparateConfirmation,
      cancellable: strategy?.cancellable ?? false,
      licenseId: tool?.licenseId || '',
    }
  })
}

export function environmentErrorPresentation(
  code: string | null | undefined,
): EnvironmentErrorPresentation {
  return (
    ERROR_PRESENTATIONS[String(code || '')] || {
      title: '环境配置发生未知错误',
      action: '刷新状态并查看日志',
    }
  )
}

export function formatEnvironmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小'
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}
