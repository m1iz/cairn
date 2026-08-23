import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, resolve, sep } from 'node:path'
import { MediaStore, type MediaRef } from './store'
import type { ToolArtifact } from '../tools/base'
import { ToolResultObj } from '../tools/base'

export interface MediaIngestOptions {
  root: string
  workspaceRoot?: string | null
  toolName: string
  arguments?: Record<string, unknown>
  turnId?: string | null
  toolCallId?: string | null
  maxArtifacts?: number
}

const IMAGE_PATH_RE =
  /(?:file:\/\/)?(?:~\/|\/|\.{1,2}\/)?[A-Za-z0-9_.~-][^\s"'`<>]*?\.(?:png|jpe?g|webp|gif)/gi
const SENSITIVE_SEGMENTS = new Set(['.cairn', '.ssh', '.aws', '.gnupg'])
const SENSITIVE_SUFFIXES = [
  ['library', 'keychains'],
  ['library', 'application support', 'google', 'chrome'],
  ['library', 'application support', 'firefox'],
  ['library', 'application support', 'braveSoftware'],
].map((parts) => parts.map((part) => part.toLowerCase()))

export function ingestToolResultMedia(
  result: ToolResultObj,
  opts: MediaIngestOptions,
): ToolResultObj {
  const root = opts.root ? resolve(opts.root) : ''
  if (!root) return result
  const sourceRoot = opts.workspaceRoot ? resolve(opts.workspaceRoot) : root
  const candidates = collectCandidatePaths(result, opts.arguments ?? {})
  if (!candidates.length) return result

  const store = new MediaStore(root)
  const existingKeys = new Set(
    result.artifacts.map((artifact) => mediaKey(artifact)),
  )
  const seenPaths = new Set<string>()
  const imported: ToolArtifact[] = []
  const maxArtifacts = opts.maxArtifacts ?? 4

  for (const candidate of candidates) {
    const absPath = resolveCandidatePath(candidate, sourceRoot)
    if (!absPath || seenPaths.has(absPath)) continue
    seenPaths.add(absPath)
    if (!isAllowedSourcePath(absPath, sourceRoot)) continue
    let ref: MediaRef
    try {
      ref = store.importImagePath(absPath, {
        sourceTool: opts.toolName,
        turnId: opts.turnId ?? null,
        toolCallId: opts.toolCallId ?? null,
      })
    } catch {
      continue
    }
    const artifact = mediaArtifact(ref, absPath, opts)
    const key = mediaKey(artifact)
    if (existingKeys.has(key)) continue
    existingKeys.add(key)
    imported.push(artifact)
    if (imported.length >= maxArtifacts) break
  }

  if (!imported.length) return result
  const modelContent = appendMediaArtifactNotice(result.modelContent, imported)
  return new ToolResultObj({
    modelContent,
    displaySummary: result.displaySummary,
    rawContent: result.rawContent,
    metadata: result.metadata,
    isError: result.isError,
    artifacts: result.artifacts.concat(imported),
  })
}

function appendMediaArtifactNotice(
  content: string,
  artifacts: ToolArtifact[],
): string {
  const media = artifacts
    .map((artifact) =>
      artifact.media ? { artifact, media: artifact.media } : null,
    )
    .filter((item) => item !== null)
  if (!media.length) return content
  const lines = [
    '[media_artifacts]',
    'The files below were imported into managed media storage and are shown inline in the conversation UI for the user. Do not say you cannot display them; keep original_path only for locating the source file. If you need to reason about image contents, use an image-capable path instead of read_file.',
    ...media.map(({ artifact, media: item }) =>
      [
        `- id: ${item.id}`,
        `  kind: ${item.kind}`,
        `  mime: ${item.mime}`,
        `  name: ${item.name}`,
        `  managed_path: ${item.relPath}`,
        `  original_path: ${item.originalPath}`,
        `  bytes: ${artifact.bytes}`,
        '  user_visible: true',
      ].join('\n'),
    ),
  ]
  const trimmed = content.trimEnd()
  return `${trimmed}${trimmed ? '\n\n' : ''}${lines.join('\n')}`
}

export function isAllowedSourcePath(
  path: string,
  root: string,
  home = homedir(),
): boolean {
  let abs: string
  try {
    abs = realpathSync(path)
  } catch {
    abs = resolve(path)
  }
  if (!existsSync(abs)) return false
  try {
    if (!statSync(abs).isFile()) return false
  } catch {
    return false
  }
  const loweredSegments = abs
    .split(/[\\/]+/)
    .map((segment) => segment.toLowerCase())
  if (loweredSegments.some((segment) => SENSITIVE_SEGMENTS.has(segment)))
    return false
  for (const suffix of SENSITIVE_SUFFIXES) {
    if (containsSubsequence(loweredSegments, suffix)) return false
  }
  const normalizedRoot = resolve(root)
  const normalizedHome = resolve(home)
  return isWithin(abs, normalizedRoot) || isWithin(abs, normalizedHome)
}

function collectCandidatePaths(
  result: ToolResultObj,
  args: Record<string, unknown>,
): string[] {
  const out: string[] = []
  for (const text of [
    result.rawContent,
    result.modelContent,
    ...result.artifacts.map((artifact) => artifact.path),
    ...stringValues(args),
  ]) {
    for (const match of String(text || '').matchAll(IMAGE_PATH_RE)) {
      const raw = cleanCandidate(match[0])
      if (raw) out.push(raw)
    }
  }
  return out
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringValues)
  if (value && typeof value === 'object')
    return Object.values(value as Record<string, unknown>).flatMap(stringValues)
  return []
}

function cleanCandidate(raw: string): string {
  let text = raw.trim().replace(/^file:\/\//, '')
  text = text.replace(/[),.;:]+$/g, '')
  if (!text) return ''
  return text
}

function resolveCandidatePath(candidate: string, root: string): string | null {
  let text = candidate
  if (text.startsWith('~')) {
    text = resolve(homedir(), text.slice(1).replace(/^[/\\]+/, ''))
  }
  return isAbsolute(text) ? resolve(text) : resolve(root, text)
}

function mediaArtifact(
  ref: MediaRef,
  originalPath: string,
  opts: MediaIngestOptions,
): ToolArtifact {
  return {
    path: originalPath,
    kind: 'media',
    bytes: ref.size,
    media: {
      id: ref.id,
      kind: ref.kind,
      mime: ref.mime,
      name: ref.name || basename(originalPath),
      relPath: ref.relPath,
      originalPath,
    },
    metadata: {
      mediaId: ref.id,
      mime: ref.mime,
      relPath: ref.relPath,
      originalPath,
      sourceTool: opts.toolName,
      ...(opts.turnId ? { turnId: opts.turnId } : {}),
      ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    },
  }
}

function mediaKey(artifact: ToolArtifact): string {
  return artifact.media?.id || `${artifact.kind}:${artifact.path}`
}

function isWithin(path: string, parent: string): boolean {
  const p = resolve(path)
  let base: string
  try {
    base = realpathSync(parent)
  } catch {
    base = resolve(parent)
  }
  const baseWithSep = base.endsWith(sep) ? base : base + sep
  return p === base || p.startsWith(baseWithSep)
}

function containsSubsequence(
  segments: string[],
  subsequence: string[],
): boolean {
  if (!subsequence.length || subsequence.length > segments.length) return false
  for (let i = 0; i <= segments.length - subsequence.length; i += 1) {
    if (subsequence.every((part, j) => segments[i + j] === part)) return true
  }
  return false
}
