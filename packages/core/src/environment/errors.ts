import { CairnError, type CairnErrorOptions } from '../errors'
import { z } from 'zod'

export const ENVIRONMENT_ERROR_CODES = [
  'catalog_invalid',
  'unsupported_platform',
  'unsupported_arch',
  'unsupported_requirement',
  'plan_stale',
  'job_active',
  'confirmation_required',
  'license_not_accepted',
  'network_unavailable',
  'proxy_failed',
  'disk_space_insufficient',
  'download_failed',
  'redirect_blocked',
  'integrity_failed',
  'publisher_mismatch',
  'elevation_declined',
  'installer_failed',
  'post_install_probe_failed',
  'cancelled',
  'interrupted',
] as const

export type EnvironmentErrorCode = (typeof ENVIRONMENT_ERROR_CODES)[number]

export const ENVIRONMENT_ERROR_ACTIONS = [
  'reinstall_application',
  'view_system_requirements',
  'review_project_requirements',
  'refresh_environment',
  'view_install_progress',
  'confirm_installation',
  'review_licenses',
  'check_network',
  'check_proxy',
  'free_disk_space',
  'retry_download',
  'report_download_issue',
  'report_publisher_issue',
  'retry_with_confirmation',
  'view_install_log',
  'review_partial_result',
] as const

export interface EnvironmentErrorDescriptor {
  message: string
  action: string
}

const DESCRIPTORS: Record<EnvironmentErrorCode, EnvironmentErrorDescriptor> = {
  catalog_invalid: {
    message: '内置环境工具目录校验失败，当前版本无法安全配置环境。',
    action: 'reinstall_application',
  },
  unsupported_platform: {
    message: '当前操作系统不在此版本的环境配置支持范围内。',
    action: 'view_system_requirements',
  },
  unsupported_arch: {
    message: '当前处理器架构不在此版本的环境配置支持范围内。',
    action: 'view_system_requirements',
  },
  unsupported_requirement: {
    message: '项目声明的版本要求无法安全解析，请手动确认版本。',
    action: 'review_project_requirements',
  },
  plan_stale: {
    message: '环境状态已经变化，请刷新后重新生成安装计划。',
    action: 'refresh_environment',
  },
  job_active: {
    message: '已有环境安装任务正在运行，请等待或查看当前任务。',
    action: 'view_install_progress',
  },
  confirmation_required: {
    message: '此安装步骤需要用户确认后才能继续。',
    action: 'confirm_installation',
  },
  license_not_accepted: {
    message: '尚未接受所需许可协议，安装没有开始。',
    action: 'review_licenses',
  },
  network_unavailable: {
    message: '网络不可用，无法获取受信任的安装资源。',
    action: 'check_network',
  },
  proxy_failed: {
    message: '代理连接失败，请检查系统代理配置后重试。',
    action: 'check_proxy',
  },
  disk_space_insufficient: {
    message: '可用磁盘空间不足，无法安全完成安装。',
    action: 'free_disk_space',
  },
  download_failed: {
    message: '安装资源下载失败，请检查网络后重试。',
    action: 'retry_download',
  },
  redirect_blocked: {
    message: '下载地址发生了不受信任的跳转，操作已阻止。',
    action: 'report_download_issue',
  },
  integrity_failed: {
    message: '安装资源完整性校验失败，文件不会被执行。',
    action: 'retry_download',
  },
  publisher_mismatch: {
    message: '安装程序发布者与受信任目录不一致，操作已阻止。',
    action: 'report_publisher_issue',
  },
  elevation_declined: {
    message: '系统授权请求被取消，相关安装步骤未执行。',
    action: 'retry_with_confirmation',
  },
  installer_failed: {
    message: '安装程序执行失败，请查看脱敏日志并重试。',
    action: 'view_install_log',
  },
  post_install_probe_failed: {
    message: '安装结束后仍未检测到所需版本，请刷新环境状态。',
    action: 'refresh_environment',
  },
  cancelled: {
    message: '环境安装任务已取消。',
    action: 'review_partial_result',
  },
  interrupted: {
    message: '上次环境安装被应用退出中断，请重新检测环境。',
    action: 'refresh_environment',
  },
}

export const environmentErrorCodeSchema = z.enum(ENVIRONMENT_ERROR_CODES)
export const environmentErrorActionSchema = z.enum(ENVIRONMENT_ERROR_ACTIONS)
export const environmentSafeErrorSchema = z
  .object({
    code: environmentErrorCodeSchema,
    message: z.string().min(1).max(1_000),
    action: environmentErrorActionSchema,
  })
  .strict()
  .superRefine((error, ctx) => {
    const descriptor = environmentErrorDescriptor(error.code)
    if (error.message !== descriptor.message)
      ctx.addIssue({
        code: 'custom',
        path: ['message'],
        message: 'message does not match the stable environment error code',
      })
    if (error.action !== descriptor.action)
      ctx.addIssue({
        code: 'custom',
        path: ['action'],
        message: 'action does not match the stable environment error code',
      })
  })

export interface EnvironmentErrorOptions extends CairnErrorOptions {
  detail?: string | null
}

export class EnvironmentError extends CairnError {
  readonly environmentCode: EnvironmentErrorCode
  readonly detail?: string

  constructor(
    code: EnvironmentErrorCode,
    options: EnvironmentErrorOptions = {},
  ) {
    const descriptor = environmentErrorDescriptor(code)
    super(descriptor.message, code, {
      ...(options.cause ? { cause: options.cause } : {}),
      action: descriptor.action,
    })
    this.environmentCode = code
    if (options.detail) this.detail = options.detail
  }
}

export function environmentErrorDescriptor(
  code: EnvironmentErrorCode,
): EnvironmentErrorDescriptor {
  return DESCRIPTORS[code]
}
