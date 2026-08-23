import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { gunzipSync } from 'node:zlib'

const BLOCK_SIZE = 512
const DEFAULT_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
const DEFAULT_MAX_FILES = 10_000
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024

export interface ExtractBoundedTarGzOptions {
  archive: string
  destination: string
  maxArchiveBytes?: number
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}

export interface ExtractBoundedTarGzResult {
  files: string[]
  totalBytes: number
}

export async function extractBoundedTarGz(
  opts: ExtractBoundedTarGzOptions,
): Promise<ExtractBoundedTarGzResult> {
  const limits = {
    archive: boundedLimit(
      opts.maxArchiveBytes,
      DEFAULT_MAX_ARCHIVE_BYTES,
      DEFAULT_MAX_ARCHIVE_BYTES,
    ),
    files: boundedLimit(opts.maxFiles, DEFAULT_MAX_FILES, 100_000),
    file: boundedLimit(
      opts.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      DEFAULT_MAX_TOTAL_BYTES,
    ),
    total: boundedLimit(
      opts.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      DEFAULT_MAX_TOTAL_BYTES,
    ),
  }
  const archiveStat = lstatSync(opts.archive)
  if (
    archiveStat.isSymbolicLink() ||
    !archiveStat.isFile() ||
    archiveStat.size > limits.archive
  )
    throw new Error('unsafe TAR archive or archive size limit exceeded')
  if (existsSync(opts.destination))
    throw new Error('TAR destination already exists')
  const parentStat = lstatSync(dirname(opts.destination))
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory())
    throw new Error('unsafe TAR destination parent')
  const compressed = readFileSync(opts.archive)
  if (compressed.byteLength !== archiveStat.size)
    throw new Error('TAR archive changed while reading')
  const maximumInflated = Math.min(
    DEFAULT_MAX_TOTAL_BYTES,
    limits.total + limits.files * BLOCK_SIZE * 3,
  )
  const archive = gunzipSync(compressed, { maxOutputLength: maximumInflated })
  const entries = parseTar(archive, limits)
  const stage = `${opts.destination}.stage-${process.pid}-${randomBytes(5).toString('hex')}`
  mkdirSync(stage, { recursive: false, mode: 0o700 })
  try {
    for (const entry of entries) {
      const target = join(stage, ...entry.name.split('/'))
      if (entry.directory) {
        mkdirSync(target, { recursive: true, mode: 0o700 })
        continue
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, entry.data, {
        flag: 'wx',
        mode: entry.executable ? 0o700 : 0o600,
      })
    }
    renameSync(stage, opts.destination)
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
  const files = entries
    .filter((entry) => !entry.directory)
    .map((entry) => entry.name)
    .sort()
  return {
    files,
    totalBytes: entries.reduce(
      (total, entry) => total + (entry.directory ? 0 : entry.data.byteLength),
      0,
    ),
  }
}

interface ParsedTarEntry {
  name: string
  data: Buffer
  directory: boolean
  executable: boolean
}

function parseTar(
  archive: Buffer,
  limits: { files: number; file: number; total: number },
): ParsedTarEntry[] {
  const entries: ParsedTarEntry[] = []
  const names = new Set<string>()
  let offset = 0
  let entryCount = 0
  let totalBytes = 0
  let pendingPath: string | null = null
  let terminated = false
  while (offset + BLOCK_SIZE <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE)
    offset += BLOCK_SIZE
    if (header.every((byte) => byte === 0)) {
      terminated = true
      break
    }
    entryCount += 1
    if (entryCount > limits.files) throw new Error('TAR entry limit exceeded')
    verifyChecksum(header)
    const size = parseTarNumber(header.subarray(124, 136), 'size')
    if (size > limits.file) throw new Error('TAR file size limit exceeded')
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
    if (offset + paddedSize > archive.byteLength)
      throw new Error('invalid TAR entry bounds')
    const data = archive.subarray(offset, offset + size)
    offset += paddedSize
    const type = byteText(header.subarray(156, 157)) || '0'
    if (type === 'x') {
      pendingPath = parsePaxPath(data)
      continue
    }
    if (type === 'L') {
      pendingPath = data.toString('utf8').replace(/\0.*$/s, '').trimEnd()
      continue
    }
    const rawName = pendingPath ?? tarHeaderName(header)
    pendingPath = null
    const directory = type === '5'
    if (type !== '0' && !directory)
      throw new Error('unsafe TAR link, device, or unsupported entry type')
    const name = normalizeMember(rawName, directory)
    if (names.has(name)) throw new Error('duplicate TAR path')
    names.add(name)
    const mode = parseTarNumber(header.subarray(100, 108), 'mode')
    if (directory && size !== 0)
      throw new Error('invalid TAR directory payload')
    if (!directory) {
      totalBytes += size
      if (totalBytes > limits.total)
        throw new Error('TAR total size limit exceeded')
    }
    entries.push({
      name,
      data,
      directory,
      executable: (mode & 0o111) !== 0,
    })
  }
  if (!terminated) throw new Error('TAR archive is not terminated')
  if (!entries.some((entry) => !entry.directory))
    throw new Error('TAR archive contains no regular files')
  return entries
}

function tarHeaderName(header: Buffer): string {
  const name = byteText(header.subarray(0, 100))
  const prefix = byteText(header.subarray(345, 500))
  return prefix ? `${prefix}/${name}` : name
}

function parsePaxPath(data: Buffer): string {
  let offset = 0
  let path: string | null = null
  while (offset < data.byteLength) {
    const space = data.indexOf(0x20, offset)
    if (space < 0) throw new Error('invalid TAR PAX record')
    const length = Number(data.toString('ascii', offset, space))
    if (
      !Number.isSafeInteger(length) ||
      length < 4 ||
      offset + length > data.length
    )
      throw new Error('invalid TAR PAX record length')
    const record = data.toString('utf8', space + 1, offset + length)
    if (!record.endsWith('\n')) throw new Error('invalid TAR PAX record')
    const equals = record.indexOf('=')
    if (equals < 1) throw new Error('invalid TAR PAX field')
    const key = record.slice(0, equals)
    const value = record.slice(equals + 1, -1)
    if (key === 'path') path = value
    offset += length
  }
  if (!path) throw new Error('TAR PAX path is missing')
  return path
}

function normalizeMember(raw: string, directory: boolean): string {
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/')
  if (
    !normalized ||
    normalized.includes('\u0000') ||
    normalized.startsWith('/') ||
    isAbsolute(normalized) ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('unsafe TAR path')
  const clean = posix.normalize(normalized)
  if (
    clean === '.' ||
    clean.startsWith('../') ||
    clean.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('unsafe TAR path')
  if (!directory && raw.endsWith('/')) throw new Error('invalid TAR path type')
  return clean
}

function verifyChecksum(header: Buffer): void {
  const expected = parseTarNumber(header.subarray(148, 156), 'checksum')
  let actual = 0
  for (let index = 0; index < header.length; index += 1)
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!
  if (actual !== expected) throw new Error('TAR checksum mismatch')
}

function parseTarNumber(field: Buffer, label: string): number {
  if ((field[0]! & 0x80) !== 0)
    throw new Error(`unsupported TAR ${label} encoding`)
  const text = field.toString('ascii').replace(/\0.*$/s, '').trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) throw new Error(`invalid TAR ${label}`)
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`invalid TAR ${label}`)
  return value
}

function byteText(field: Buffer): string {
  return field.toString('utf8').replace(/\0.*$/s, '')
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error('invalid TAR limit')
  return value
}
