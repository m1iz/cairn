import { gzipSync } from 'node:zlib'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractBoundedTarGz } from './tar'

describe('extractBoundedTarGz', () => {
  it.skipIf(process.platform === 'win32')(
    'extracts regular files and preserves executable bits',
    async () => {
      const root = tempRoot()
      const archive = join(root, 'tool.tar.gz')
      const destination = join(root, 'tool')
      writeFileSync(
        archive,
        tarGz([
          { name: 'bin/tool', data: Buffer.from('binary'), mode: 0o755 },
          { name: 'LICENSE', data: Buffer.from('license'), mode: 0o644 },
        ]),
      )

      const result = await extractBoundedTarGz({ archive, destination })

      expect(result.files).toEqual(['LICENSE', 'bin/tool'])
      expect(readFileSync(join(destination, 'bin', 'tool'), 'utf8')).toBe(
        'binary',
      )
      expect(statSync(join(destination, 'bin', 'tool')).mode & 0o100).toBe(
        0o100,
      )
    },
  )

  it('rejects traversal and absolute members', async () => {
    for (const name of ['../escape', 'a/../escape', '/absolute']) {
      const root = tempRoot()
      const archive = join(root, 'tool.tar.gz')
      writeFileSync(archive, tarGz([{ name, data: Buffer.from('bad') }]))

      await expect(
        extractBoundedTarGz({ archive, destination: join(root, 'tool') }),
      ).rejects.toThrow(/unsafe|path/i)
      expect(existsSync(join(root, 'escape'))).toBe(false)
    }
  })

  it('rejects links and enforces entry, file, and total limits', async () => {
    const root = tempRoot()
    const linked = join(root, 'linked.tar.gz')
    writeFileSync(
      linked,
      tarGz([{ name: 'link', data: Buffer.alloc(0), type: '2' }]),
    )
    await expect(
      extractBoundedTarGz({
        archive: linked,
        destination: join(root, 'linked'),
      }),
    ).rejects.toThrow(/link|type|unsafe/i)

    const archive = join(root, 'limited.tar.gz')
    writeFileSync(
      archive,
      tarGz([
        { name: 'a', data: Buffer.alloc(8) },
        { name: 'b', data: Buffer.alloc(8) },
      ]),
    )
    await expect(
      extractBoundedTarGz({
        archive,
        destination: join(root, 'entry-limit'),
        maxFiles: 1,
      }),
    ).rejects.toThrow(/entry|file|limit/i)
    await expect(
      extractBoundedTarGz({
        archive,
        destination: join(root, 'file-limit'),
        maxFileBytes: 4,
      }),
    ).rejects.toThrow(/file|size|limit/i)
    await expect(
      extractBoundedTarGz({
        archive,
        destination: join(root, 'total-limit'),
        maxTotalBytes: 12,
      }),
    ).rejects.toThrow(/total|size|limit/i)
  })
})

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'cairn-tar-'))
}

function tarGz(
  entries: Array<{
    name: string
    data: Buffer
    mode?: number
    type?: string
  }>,
): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    writeTarText(header, 0, 100, entry.name)
    writeTarOctal(header, 100, 8, entry.mode ?? 0o644)
    writeTarOctal(header, 108, 8, 0)
    writeTarOctal(header, 116, 8, 0)
    writeTarOctal(header, 124, 12, entry.data.byteLength)
    writeTarOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header.write(entry.type ?? '0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    writeTarOctal(
      header,
      148,
      8,
      [...header].reduce((sum, byte) => sum + byte, 0),
    )
    blocks.push(header, entry.data)
    const padding = (512 - (entry.data.byteLength % 512)) % 512
    if (padding) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function writeTarText(
  buffer: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  buffer.write(
    value,
    offset,
    Math.min(length, Buffer.byteLength(value)),
    'utf8',
  )
}

function writeTarOctal(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const text = value.toString(8).padStart(length - 2, '0')
  buffer.write(`${text}\0 `, offset, length, 'ascii')
}
