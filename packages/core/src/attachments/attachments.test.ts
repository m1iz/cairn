import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AttachmentStore, MAX_IMAGE_BYTES, TEXT_INLINE_LIMIT } from './store'
import {
  buildUserContent,
  encodeForOpenAIBlock,
  refToJson,
  type UserContent,
} from './encode'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('AttachmentStore (agent/attachments.py parity)', () => {
  it('saves text attachments with safe names, sidecars, ids, and lookup by id', () => {
    const root = tmp('cairn-attachments-text-')
    const store = new AttachmentStore(root)
    const ref = store.save({
      raw: Buffer.from('hello\nworld', 'utf8'),
      name: '../报告.md',
      mime: 'text/markdown',
    })

    expect(ref.id).toMatch(/^att_\d{4}-\d{2}_[0-9a-f]{8}$/)
    expect(ref.kind).toBe('text')
    expect(ref.has_text).toBe(true)
    expect(ref.has_image).toBe(false)
    expect(ref.rel_path).toContain('memory/attachments/')
    expect(basename(ref.rel_path)).not.toContain('/')
    expect(existsSync(join(root, ref.rel_path))).toBe(true)
    expect(existsSync(join(root, ref.text_rel_path!))).toBe(true)
    expect(store.readText(ref)).toBe('hello\nworld')

    const fresh = new AttachmentStore(root)
    const loaded = fresh.get(ref.id)!
    expect(loaded.rel_path).toBe(ref.rel_path)
    expect(loaded.text_rel_path).toBe(ref.text_rel_path)
    expect(loaded.name).toBe(
      basename(ref.rel_path).replace(/^[0-9a-f]{8}-/, ''),
    )
  })

  it('validates mime and size limits', () => {
    const store = new AttachmentStore(tmp('cairn-attachments-limits-'))
    expect(() =>
      store.save({
        raw: Buffer.from('x'),
        name: 'bad.exe',
        mime: 'application/x-msdownload',
      }),
    ).toThrow(/unsupported mime/)
    expect(() =>
      store.save({
        raw: Buffer.alloc(MAX_IMAGE_BYTES + 1),
        name: 'big.png',
        mime: 'image/png',
      }),
    ).toThrow(/file too large/)
  })

  it('extracts pdf text through the injected extractor without blocking uploads when absent', () => {
    const root = tmp('cairn-attachments-pdf-')
    const noExtractor = new AttachmentStore(root)
    const pdf = Buffer.from('%PDF-1.4\nfake', 'utf8')
    const noText = noExtractor.save({
      raw: pdf,
      name: 'doc.pdf',
      mime: 'application/pdf',
    })
    expect(noText.kind).toBe('document')
    expect(noText.has_text).toBe(false)

    const withExtractor = new AttachmentStore(root, {
      pdfTextExtractor: () => 'PDF text',
    })
    const withText = withExtractor.save({
      raw: Buffer.from('%PDF-1.4\nother', 'utf8'),
      name: 'doc.pdf',
      mime: 'application/pdf',
    })
    expect(withText.has_text).toBe(true)
    expect(withExtractor.readText(withText)).toBe('PDF text')
  })

  it('truncates sidecar text like the Python store', () => {
    const store = new AttachmentStore(tmp('cairn-attachments-truncate-'))
    const text = 'a'.repeat(TEXT_INLINE_LIMIT + 100)
    const ref = store.save({
      raw: Buffer.from(text),
      name: 'long.txt',
      mime: 'text/plain',
    })
    const out = store.readText(ref)
    expect(out.length).toBeLessThan(text.length)
    expect(out).toContain('[truncated, total')
  })
})

describe('attachment encoding and chat content assembly', () => {
  it('encodes image refs to OpenAI image_url blocks and JSON refs', () => {
    const store = new AttachmentStore(tmp('cairn-attachments-image-'))
    const ref = store.save({
      raw: Buffer.from([1, 2, 3, 4]),
      name: 'pic.png',
      mime: 'image/png',
    })
    const block = encodeForOpenAIBlock(ref, store)

    expect(block).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AQIDBA==' },
    })
    expect(refToJson(ref)).toMatchObject({
      id: ref.id,
      name: 'pic.png',
      hasText: false,
      hasImage: true,
      path: ref.rel_path,
      textPath: null,
    })
    expect(statSync(join(store.root, ref.rel_path)).size).toBe(4)
  })

  it('builds model user content for document text plus vision image blocks', () => {
    const store = new AttachmentStore(tmp('cairn-attachments-content-'))
    const text = store.save({
      raw: Buffer.from('line one'),
      name: 'notes.txt',
      mime: 'text/plain',
    })
    const image = store.save({
      raw: Buffer.from([255]),
      name: 'x.jpg',
      mime: 'image/jpeg',
    })

    const content = buildUserContent(
      'see attached',
      [text.id, image.id],
      store,
      { supportsVision: true },
    )
    expect(Array.isArray(content)).toBe(true)
    const blocks = content as Exclude<UserContent, string>
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect(String((blocks[0] as { text: string }).text)).toContain(
      '[附件 notes.txt 提取文本]',
    )
    expect(String((blocks[0] as { text: string }).text)).toContain(
      `[已落盘: ${text.rel_path}]`,
    )
    expect(blocks[1]).toMatchObject({ type: 'image_url' })
  })

  it('keeps non-vision image attachments visible as text fallback', () => {
    const store = new AttachmentStore(tmp('cairn-attachments-no-vision-'))
    const image = store.save({
      raw: Buffer.from([9]),
      name: 'x.webp',
      mime: 'image/webp',
    })
    const content = buildUserContent('', [image.id], store, {
      supportsVision: false,
    })
    expect(typeof content).toBe('string')
    expect(content).toContain('当前模型未标记视觉')
    expect(content).toContain(image.rel_path)
  })
})
