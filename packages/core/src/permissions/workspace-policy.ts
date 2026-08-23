import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import {
  canonicalizeExistingPath,
  isPathWithin,
  pathsEqual,
} from '../util/paths'

export type WorkspaceAccess = 'read' | 'write' | 'execute' | 'media'
export type OutsideWorkspaceBehavior = 'deny' | 'allow_read'

export interface WorkspaceRootSpec {
  path: string
  label?: string
}

export interface WorkspacePolicyOptions {
  workspaceRoot?: string | null
  stateRoot?: string | null
  allowRoots?: Array<string | WorkspaceRootSpec> | null
  denyRoots?: Array<string | WorkspaceRootSpec> | null
  readOnlyRoots?: Array<string | WorkspaceRootSpec> | null
  outsideWorkspace?: OutsideWorkspaceBehavior
}

export interface WorkspacePolicyExecutionContext {
  root?: string | null
  workspaceRoot?: string | null
}

export interface WorkspaceRootReceipt {
  path: string
  label: string
}

export interface WorkspacePathDecision {
  allowed: boolean
  access: WorkspaceAccess
  requestedPath: string
  resolvedPath: string
  realPath: string
  reason: string
  matchedRoot: WorkspaceRootReceipt | null
  allowedRoots: WorkspaceRootReceipt[]
  denyRoots: WorkspaceRootReceipt[]
  readOnlyRoots: WorkspaceRootReceipt[]
  outsideWorkspace: OutsideWorkspaceBehavior
}

interface ResolvedRoot extends WorkspaceRootReceipt {
  realPath: string
}

export class WorkspacePolicy {
  readonly workspaceRoot: string | null
  readonly stateRoot: string | null
  readonly outsideWorkspace: OutsideWorkspaceBehavior
  private readonly allowRootEntries: ResolvedRoot[]
  private readonly denyRootEntries: ResolvedRoot[]
  private readonly readOnlyRootEntries: ResolvedRoot[]

  constructor(opts: WorkspacePolicyOptions = {}) {
    this.workspaceRoot = normalizeRoot(opts.workspaceRoot)
    this.stateRoot = normalizeRoot(opts.stateRoot)
    this.outsideWorkspace = opts.outsideWorkspace ?? 'deny'
    const defaultAllow = this.workspaceRoot
      ? [{ path: this.workspaceRoot, label: 'workspace' }]
      : []
    const defaultDeny =
      this.stateRoot && this.stateRoot !== this.workspaceRoot
        ? [{ path: this.stateRoot, label: 'state' }]
        : []
    this.allowRootEntries = normalizeRoots(
      opts.allowRoots ?? defaultAllow,
      'workspace',
    )
    this.denyRootEntries = normalizeRoots(
      opts.denyRoots ?? defaultDeny,
      'denied',
    )
    this.readOnlyRootEntries = normalizeRoots(
      opts.readOnlyRoots ?? [],
      'read_only',
    )
  }

  resolvePath(
    rawPath: string,
    access: WorkspaceAccess,
    opts: { baseRoot?: string | null } = {},
  ): WorkspacePathDecision {
    const requestedPath = String(rawPath ?? '')
    const baseRoot = normalizeRoot(opts.baseRoot) ?? this.workspaceRoot
    const resolvedPath = resolveCandidatePath(requestedPath, baseRoot)
    const realPath = canonicalizeExistingPath(resolvedPath)
    const base = this.baseDecision(
      access,
      requestedPath,
      resolvedPath,
      realPath,
    )

    const denied = this.findRoot(this.denyRootEntries, resolvedPath, realPath)
    if (denied) {
      return {
        ...base,
        allowed: false,
        reason: `path is inside denied root: ${denied.path}`,
        matchedRoot: publicRoot(denied),
      }
    }

    const readOnly = this.findRoot(
      this.readOnlyRootEntries,
      resolvedPath,
      realPath,
    )
    if (readOnly && access !== 'read' && access !== 'media') {
      return {
        ...base,
        allowed: false,
        reason: `path is inside read-only root: ${readOnly.path}`,
        matchedRoot: publicRoot(readOnly),
      }
    }

    const allowed = this.findAllowedRoot(
      this.allowRootEntries,
      resolvedPath,
      realPath,
    )
    if (allowed) {
      return {
        ...base,
        allowed: true,
        reason: '',
        matchedRoot: publicRoot(allowed),
      }
    }

    if (this.outsideWorkspace === 'allow_read' && access === 'read') {
      return {
        ...base,
        allowed: true,
        reason: '',
        matchedRoot: null,
      }
    }

    return {
      ...base,
      allowed: false,
      reason: 'path is outside workspace',
      matchedRoot: null,
    }
  }

  describe(): Record<string, unknown> {
    return {
      workspaceRoot: this.workspaceRoot,
      stateRoot: this.stateRoot,
      allowRoots: this.allowRootEntries.map(publicRoot),
      denyRoots: this.denyRootEntries.map(publicRoot),
      readOnlyRoots: this.readOnlyRootEntries.map(publicRoot),
      outsideWorkspace: this.outsideWorkspace,
    }
  }

  private baseDecision(
    access: WorkspaceAccess,
    requestedPath: string,
    resolvedPath: string,
    realPath: string,
  ): WorkspacePathDecision {
    return {
      allowed: false,
      access,
      requestedPath,
      resolvedPath,
      realPath,
      reason: '',
      matchedRoot: null,
      allowedRoots: this.allowRootEntries.map(publicRoot),
      denyRoots: this.denyRootEntries.map(publicRoot),
      readOnlyRoots: this.readOnlyRootEntries.map(publicRoot),
      outsideWorkspace: this.outsideWorkspace,
    }
  }

  private findRoot(
    roots: ResolvedRoot[],
    resolvedPath: string,
    realPath: string,
  ): ResolvedRoot | null {
    return (
      roots.find(
        (root) =>
          isPathWithin(resolvedPath, root.path) ||
          isPathWithin(realPath, root.realPath),
      ) ?? null
    )
  }

  private findAllowedRoot(
    roots: ResolvedRoot[],
    resolvedPath: string,
    realPath: string,
  ): ResolvedRoot | null {
    return (
      roots.find(
        (root) =>
          isPathWithin(resolvedPath, root.path) &&
          isPathWithin(realPath, root.realPath),
      ) ?? null
    )
  }
}

export function workspacePolicyForTool(
  ctx: WorkspacePolicyExecutionContext | null | undefined,
  fallbackWorkspace: string | null,
): WorkspacePolicy {
  const workspaceRoot =
    normalizeRoot(ctx?.workspaceRoot) ??
    normalizeRoot(ctx?.root) ??
    normalizeRoot(fallbackWorkspace)
  const root = normalizeRoot(ctx?.root)
  const stateRoot =
    root && workspaceRoot && !pathsEqual(root, workspaceRoot) ? root : null
  return new WorkspacePolicy({ workspaceRoot, stateRoot })
}

export function formatWorkspacePolicyError(
  decision: WorkspacePathDecision,
): string {
  const deniedRoot = decision.reason.includes('denied root')
  const prefix = deniedRoot
    ? '[ERR] path denied by workspace policy'
    : '[ERR] path is outside workspace'
  return [
    `${prefix}: ${decision.reason || 'blocked'}`,
    `requested: ${decision.requestedPath || '(empty)'}`,
    `resolved: ${decision.resolvedPath}`,
    `allowed_roots: ${formatRoots(decision.allowedRoots)}`,
    `denied_roots: ${formatRoots(decision.denyRoots)}`,
  ].join('; ')
}

export function isWithinWorkspaceRoot(path: string, root: string): boolean {
  return isPathWithin(
    canonicalizeExistingPath(resolve(path)),
    canonicalizeExistingPath(resolve(root)),
  )
}

function normalizeRoot(root: string | null | undefined): string | null {
  const value = String(root ?? '').trim()
  return value ? resolve(expandHome(value)) : null
}

function normalizeRoots(
  values: Array<string | WorkspaceRootSpec>,
  defaultLabel: string,
): ResolvedRoot[] {
  const out: ResolvedRoot[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const raw = typeof value === 'string' ? value : value.path
    const path = normalizeRoot(raw)
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push({
      path,
      realPath: canonicalizeExistingPath(path),
      label:
        typeof value === 'string' ? defaultLabel : value.label || defaultLabel,
    })
  }
  return out
}

function publicRoot(root: ResolvedRoot): WorkspaceRootReceipt {
  return { path: root.path, label: root.label }
}

function formatRoots(roots: WorkspaceRootReceipt[]): string {
  return roots.map((root) => root.path).join(', ') || '(none)'
}

function resolveCandidatePath(
  rawPath: string,
  baseRoot: string | null,
): string {
  const expanded = expandHome(normalize(String(rawPath || '.')))
  if (isAbsolute(expanded)) return resolve(expanded)
  return baseRoot ? resolve(baseRoot, expanded) : resolve(expanded)
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\'))
    return join(homedir(), path.slice(2))
  return path
}
