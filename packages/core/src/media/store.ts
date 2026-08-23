import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { safeName } from '../attachments/store'

export type MediaKind = 'image'

export interface MediaRef {
  id: string
  kind: MediaKind
  mime: string
  name: string
  size: number
  relPath: string
  originalPath: string
}

export interface MediaImportMetadata {
  sourceTool?: string | null
  turnId?: string | null
  toolCallId?: string | null
}

export const MAX_MEDIA_IMAGE_BYTES = 10 * 1024 * 1024

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export class MediaStore {
  readonly root: string
  readonly base: string
  private readonly now: () => Date
  private readonly cache = new Map<string, MediaRef>()
  private readonly cacheMax = 64

  constructor(root: string, opts: { now?: () => Date } = {}) {
    this.root = resolve(root)
    this.base = join(this.root, 'memory', 'media')
    this.now = opts.now ?? (() => new Date())
    mkdirSync(this.base, { recursive: true })
  }

  importImagePath(
    sourcePath: string,
    _metadata: MediaImportMetadata = {},
  ): MediaRef {
    const originalPath = resolve(sourcePath)
    let stat
    try {
      stat = statSync(originalPath)
    } catch {
      throw new Error(`media source not found: ${sourcePath}`)
    }
    if (!stat.isFile())
      throw new Error(`media source is not a file: ${sourcePath}`)
    if (stat.size > MAX_MEDIA_IMAGE_BYTES) {
      throw new Error(`media file too large: ${stat.size} bytes`)
    }

    const raw = readFileSync(originalPath)
    const mime = detectImageMime(raw)
    if (!mime) throw new Error(`unsupported media: ${sourcePath}`)

    const hash8 = createHash('sha256').update(raw).digest('hex').slice(0, 8)
    const month = utc8Month(this.now())
    const id = `media_${month}_${hash8}`
    const monthDir = join(this.base, month)
    mkdirSync(monthDir, { recursive: true })

    const existing = firstFileWithHash(monthDir, hash8)
    const fileName =
      existing ?? mediaFileName(hash8, basename(originalPath), mime)
    const absPath = join(monthDir, fileName)
    if (!existing) writeFileSync(absPath, raw)

    const ref: MediaRef = {
      id,
      kind: 'image',
      mime,
      name: fileName.replace(/^[0-9a-f]{8}-/, ''),
      size: statSync(absPath).size,
      relPath: toPosix(relative(this.root, absPath)),
      originalPath,
    }
    this.cachePut(ref)
    return ref
  }

  get(mediaId: string): MediaRef | null {
    const cached = this.cache.get(mediaId)
    if (cached) {
      this.cache.delete(mediaId)
      this.cache.set(mediaId, cached)
      return cached
    }
    const match = /^media_(\d{4}-\d{2})_([0-9a-f]{8})$/.exec(mediaId)
    if (!match) return null
    const [, month, hash8] = match
    const monthDir = join(this.base, month!)
    const fileName = firstFileWithHash(monthDir, hash8!)
    if (!fileName) return null
    const absPath = join(monthDir, fileName)
    const raw = readFileSync(absPath)
    const mime = detectImageMime(raw)
    if (!mime) return null
    const ref: MediaRef = {
      id: mediaId,
      kind: 'image',
      mime,
      name: fileName.replace(/^[0-9a-f]{8}-/, ''),
      size: statSync(absPath).size,
      relPath: toPosix(relative(this.root, absPath)),
      originalPath: '',
    }
    this.cachePut(ref)
    return ref
  }

  rawPath(mediaId: string): string | null {
    const ref = this.get(mediaId)
    return ref ? join(this.root, ref.relPath) : null
  }

  private cachePut(ref: MediaRef): void {
    if (this.cache.has(ref.id)) this.cache.delete(ref.id)
    this.cache.set(ref.id, ref)
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}

export function detectImageMime(raw: Buffer): string | null {
  if (
    raw.length >= 8 &&
    raw
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (
    raw.length >= 3 &&
    raw[0] === 0xff &&
    raw[1] === 0xd8 &&
    raw[2] === 0xff
  ) {
    return 'image/jpeg'
  }
  if (raw.length >= 6 && raw.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif'
  }
  if (
    raw.length >= 12 &&
    raw.subarray(0, 4).toString('ascii') === 'RIFF' &&
    raw.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

function mediaFileName(
  hash8: string,
  sourceName: string,
  mime: string,
): string {
  const ext = EXT_BY_MIME[mime] ?? 'bin'
  const safe = safeName(sourceName)
  const finalName = safe.toLowerCase().endsWith(`.${ext}`)
    ? safe
    : `${safe}.${ext}`
  return `${hash8}-${finalName}`
}

function firstFileWithHash(dir: string, hash8: string): string | null {
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.startsWith(`${hash8}-`)) continue
    const candidate = join(dir, name)
    try {
      if (statSync(candidate).isFile()) return name
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function utc8Month(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7)
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
