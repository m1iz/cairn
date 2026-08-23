import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MediaStore } from './store'
import { Tool } from '../tools/base'
import { ToolRegistry } from '../tools/registry'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function pngBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
  ])
}

class StaticTool extends Tool {
  override readonly name = 'run_command'
  override readonly description = 'test tool'
  override readonly parameters = {
    type: 'object',
    properties: {},
    required: [],
  } as any

  constructor(private readonly output: string) {
    super()
  }

  override execute(): string {
    return this.output
  }
}

describe('MediaStore', () => {
  it('imports image files into managed media storage and reloads them by id', () => {
    const root = tmp('cairn-media-store-')
    const source = join(root, 'screen.png')
    writeFileSync(source, pngBytes())

    const store = new MediaStore(root)
    const ref = store.importImagePath(source, {
      sourceTool: 'run_command',
      turnId: 'turn-1',
      toolCallId: 'call-1',
    })

    expect(ref.id).toMatch(/^media_\d{4}-\d{2}_[0-9a-f]{8}$/)
    expect(ref.kind).toBe('image')
    expect(ref.mime).toBe('image/png')
    expect(ref.originalPath).toBe(source)
    expect(ref.relPath).toContain('memory/media/')
    expect(existsSync(join(root, ref.relPath))).toBe(true)

    const loaded = new MediaStore(root).get(ref.id)
    expect(loaded).toMatchObject({
      id: ref.id,
      kind: 'image',
      mime: 'image/png',
      relPath: ref.relPath,
    })
  })

  it('rejects non-image files', () => {
    const root = tmp('cairn-media-reject-')
    const source = join(root, 'notes.txt')
    writeFileSync(source, 'not an image')

    expect(() => new MediaStore(root).importImagePath(source)).toThrow(
      /unsupported media/,
    )
  })
})

describe('tool media ingestion', () => {
  it('imports image paths from tool output as media artifacts', async () => {
    const root = tmp('cairn-media-ingest-')
    const source = join(root, 'desktop_screenshot.png')
    writeFileSync(source, pngBytes())
    const registry = new ToolRegistry(root)
    registry.register(new StaticTool(`saved to ${source}`))

    const result = await registry.executeResult('run_command', {})

    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]).toMatchObject({
      path: source,
      kind: 'media',
      media: {
        kind: 'image',
        mime: 'image/png',
        originalPath: source,
      },
    })
    expect(result.artifactPayloads()[0]).toMatchObject({
      media: {
        kind: 'image',
        originalPath: source,
      },
    })
    expect(result.modelContent).toContain('[media_artifacts]')
    expect(result.modelContent).toContain('user_visible: true')
    expect(result.modelContent).toContain(`original_path: ${source}`)
    expect(result.modelContent).toContain('shown inline in the conversation UI')
  })

  it('deduplicates repeated image paths and ignores sensitive directories', async () => {
    const root = tmp('cairn-media-ingest-')
    const visible = join(root, 'visible.png')
    const sensitiveDir = join(root, '.ssh')
    const hidden = join(sensitiveDir, 'secret.png')
    mkdirSync(sensitiveDir, { recursive: true })
    writeFileSync(visible, pngBytes())
    writeFileSync(hidden, pngBytes())
    const registry = new ToolRegistry(root)
    registry.register(new StaticTool(`${visible}\n${visible}\n${hidden}`))

    const result = await registry.executeResult('run_command', {})

    expect(result.artifacts.map((item) => item.path)).toEqual([visible])
  })

  it('imports bare relative image paths from the workspace', async () => {
    const root = tmp('cairn-media-relative-')
    const source = join(root, 'screen.png')
    writeFileSync(source, pngBytes())
    const registry = new ToolRegistry(root)
    registry.register(new StaticTool('screen.png'))

    const result = await registry.executeResult('run_command', {})

    expect(result.artifacts[0]?.media?.originalPath).toBe(source)
  })

  it('resolves relative image paths from workspaceRoot while storing media under runtime root', async () => {
    const root = tmp('cairn-media-runtime-root-')
    const workspaceRoot = tmp('cairn-media-workspace-root-')
    const source = join(workspaceRoot, 'screen.png')
    writeFileSync(source, pngBytes())
    const registry = new ToolRegistry(root)
    registry.register(new StaticTool('screen.png'))

    const result = await registry.executeResult(
      'run_command',
      {},
      { workspaceRoot },
    )
    const media = result.artifacts[0]?.media

    expect(media?.originalPath).toBe(source)
    expect(media?.relPath).toContain('memory/media/')
    expect(existsSync(join(root, media!.relPath))).toBe(true)
    expect(existsSync(join(workspaceRoot, 'memory'))).toBe(false)
  })

  it('tells the model about image media imported from tool arguments even when the tool result is an error', async () => {
    const root = tmp('cairn-media-error-')
    const source = join(root, 'screen.png')
    writeFileSync(source, pngBytes())
    const registry = new ToolRegistry(root)
    registry.register(new StaticTool('[ERR] path is outside workspace'))

    const result = await registry.executeResult('run_command', { path: source })

    expect(result.modelContent).toContain('[ERR] path is outside workspace')
    expect(result.modelContent).toContain('[media_artifacts]')
    expect(result.modelContent).toContain(`original_path: ${source}`)
    expect(result.modelContent).toContain('user_visible: true')
    expect(result.artifacts[0]?.media?.originalPath).toBe(source)
  })
})
