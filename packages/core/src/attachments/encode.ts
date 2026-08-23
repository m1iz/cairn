import { AttachmentRef, AttachmentStore } from './store'

export interface OpenAIImageUrlBlock {
  type: 'image_url'
  image_url: { url: string }
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface AnthropicImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

export type UserContent = string | Array<TextBlock | OpenAIImageUrlBlock>

export function encodeForOpenAIBlock(
  ref: AttachmentRef,
  store: AttachmentStore,
): OpenAIImageUrlBlock {
  if (!ref.has_image) throw new Error(`attachment ${ref.id} is not an image`)
  const b64 = store.readBytes(ref).toString('base64')
  return {
    type: 'image_url',
    image_url: { url: `data:${ref.mime};base64,${b64}` },
  }
}

export function encodeForAnthropicBlock(
  ref: AttachmentRef,
  store: AttachmentStore,
): AnthropicImageBlock {
  if (!ref.has_image) throw new Error(`attachment ${ref.id} is not an image`)
  const b64 = store.readBytes(ref).toString('base64')
  return {
    type: 'image',
    source: { type: 'base64', media_type: ref.mime, data: b64 },
  }
}

export function refToJson(ref: AttachmentRef): Record<string, unknown> {
  return {
    id: ref.id,
    name: ref.name,
    mime: ref.mime,
    size: ref.size,
    kind: ref.kind,
    hasText: ref.has_text,
    hasImage: ref.has_image,
    path: ref.rel_path,
    textPath: ref.text_rel_path,
  }
}

export function buildUserContent(
  text: string,
  attachmentIds: string[],
  store: AttachmentStore,
  opts: { supportsVision: boolean },
): UserContent {
  if (!attachmentIds.length) return text
  const refs = attachmentIds
    .map((id) => store.get(id))
    .filter((ref): ref is AttachmentRef => ref !== null)
  if (!refs.length) return text

  const imageBlocks: OpenAIImageUrlBlock[] = []
  const textPieces: string[] = text ? [text] : []
  for (const ref of refs) {
    if (ref.kind === 'image') {
      if (opts.supportsVision) {
        try {
          imageBlocks.push(encodeForOpenAIBlock(ref, store))
        } catch (error) {
          textPieces.push(
            `\n[图片附件 ${ref.name} 编码失败：${error instanceof Error ? error.message : String(error)}]`,
          )
        }
      } else {
        textPieces.push(
          `\n[图片附件 ${ref.name}（当前模型未标记视觉，已忽略；可在 /model 测试视觉激活）]`,
        )
      }
    } else if (ref.has_text) {
      const extracted = store.readText(ref)
      if (extracted)
        textPieces.push(
          `\n\n[附件 ${ref.name} 提取文本]\n${extracted}\n[/附件 ${ref.name}]`,
        )
      else textPieces.push(`\n[附件 ${ref.name} 已落盘但抽取文本为空]`)
    } else {
      textPieces.push(
        `\n[附件 ${ref.name} 已落盘: ${ref.rel_path}（用 read_file 读取）]`,
      )
    }
    textPieces.push(`\n[已落盘: ${ref.rel_path}]`)
  }

  const fullText = textPieces.join('').trim()
  if (imageBlocks.length) {
    const blocks: Array<TextBlock | OpenAIImageUrlBlock> = []
    if (fullText) blocks.push({ type: 'text', text: fullText })
    blocks.push(...imageBlocks)
    return blocks
  }
  return fullText || text
}
