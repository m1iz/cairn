import { describe, expect, it } from 'vitest'
import type { CoreOperationResult } from '@cairn/core'
import {
  environmentErrorPresentation,
  environmentJobStatusLabel,
  environmentPlanReview,
  environmentToolSections,
  environmentToolStatusLabel,
  environmentToolTone,
  formatEnvironmentBytes,
  installableEnvironmentToolIds,
} from './environmentPanelModel'

type StatusPayload = CoreOperationResult<'environment.getStatus'>
type Plan = CoreOperationResult<'environment.createInstallPlan'>

describe('environment panel model', () => {
  it('groups ready, missing, mismatched, blocked and large dependencies', () => {
    const payload = statusPayload()

    expect(
      environmentToolSections(payload).map((group) => group.title),
    ).toEqual(['基础工具', '当前项目', 'Skill 依赖', '大型依赖'])
    expect(installableEnvironmentToolIds(payload)).toEqual(['git', 'node'])
    expect(environmentToolTone('ready')).toBe('ok')
    expect(environmentToolTone('missing')).toBe('warn')
    expect(environmentToolTone('blocked')).toBe('error')
    expect(environmentToolStatusLabel('version_mismatch')).toBe('版本不匹配')
  })

  it('projects only signed display metadata into the confirmation review', () => {
    const plan = {
      planId: 'plan_1',
      catalogRevision: 'a'.repeat(64),
      projectFingerprint: 'b'.repeat(64),
      toolStateHash: 'c'.repeat(64),
      expiresAt: '2026-07-11T12:10:00.000Z',
      requiredLicenseIds: ['git-gpl-2'],
      warnings: ['需要系统授权'],
      steps: [
        {
          stepId: 'step_git',
          toolId: 'git',
          strategyId: 'git-system',
          dependsOn: [],
          status: 'planned',
          requiresElevation: true,
          requiresSeparateConfirmation: false,
        },
      ],
    } as Plan

    expect(environmentPlanReview(plan, statusPayload())).toEqual([
      expect.objectContaining({
        displayName: 'Git',
        version: '2.55.0',
        publisher: 'Git Project',
        estimatedBytes: 10_000_000,
        requiresElevation: true,
        cancellable: true,
        licenseId: 'git-gpl-2',
      }),
    ])
    expect(
      JSON.stringify(environmentPlanReview(plan, statusPayload())),
    ).not.toMatch(/"(?:command|args|executable)"/)
  })

  it('maps every stable error code to a Chinese recovery action', () => {
    for (const code of [
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
    ]) {
      const presentation = environmentErrorPresentation(code)
      expect(presentation.title).toMatch(/[\u4e00-\u9fff]/)
      expect(presentation.action).toMatch(/[\u4e00-\u9fff]/)
    }
    expect(environmentJobStatusLabel('partial')).toBe('部分完成')
    expect(formatEnvironmentBytes(20 * 1024 * 1024)).toBe('20.0 MB')
  })
})

function statusPayload(): StatusPayload {
  const tool = (
    id: 'git' | 'node' | 'python' | 'msvc-build-tools',
    category: StatusPayload['status']['tools'][number]['category'],
    status: StatusPayload['status']['tools'][number]['status'],
    installStrategy: string | null,
  ) => ({
    id,
    category,
    required: true,
    reason: `${id} required`,
    declarationSource: null,
    status,
    detectedVersion: status === 'ready' ? '1.0.0' : null,
    versionSummary: null,
    requiredVersion: '>=1.0.0',
    executablePath: status === 'ready' ? `/tools/${id}` : null,
    installStrategy,
    sourceUrl: installStrategy ? 'https://example.com/tool.zip' : null,
    requiresElevation: id === 'msvc-build-tools',
    requiresSeparateConfirmation: id === 'msvc-build-tools',
  })
  return {
    status: {
      cacheKey: 'd'.repeat(64),
      catalogRevision: 'a'.repeat(64),
      projectFingerprint: 'b'.repeat(64),
      project: {
        projectRoot: '/workspace',
        fingerprint: 'b'.repeat(64),
        declarations: {} as StatusPayload['status']['project']['declarations'],
        files: [],
        diagnostics: [],
      },
      platform: 'darwin',
      arch: 'arm64',
      pathEntries: ['/usr/bin'],
      tools: [
        tool('git', 'base', 'missing', 'git-system'),
        tool('node', 'project', 'version_mismatch', 'node-volta'),
        tool('python', 'skill', 'blocked', null),
        tool('msvc-build-tools', 'large-prerequisite', 'unsupported', null),
      ],
      skills: [],
      diagnostics: [],
    },
    catalog: {
      revision: 'a'.repeat(64),
      release: '2026.07',
      licenses: [
        {
          id: 'git-gpl-2',
          name: 'GNU GPL 2.0',
          spdx: 'GPL-2.0-only',
          url: 'https://example.com/license',
        },
      ],
      tools: [
        {
          id: 'git',
          displayName: 'Git',
          pinnedVersion: '2.55.0',
          licenseId: 'git-gpl-2',
          strategies: [
            {
              id: 'git-system',
              kind: 'package_manager',
              sourceUrl: 'https://git-scm.com',
              publisher: 'Git Project',
              estimatedBytes: 10_000_000,
              requiresElevation: true,
              requiresSeparateConfirmation: false,
              cancellable: true,
            },
          ],
        },
      ],
    },
    activeJob: null,
    recentJobs: [],
  } as StatusPayload
}
