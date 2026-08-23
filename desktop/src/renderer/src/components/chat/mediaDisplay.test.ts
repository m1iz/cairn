import { describe, expect, it } from 'vitest'
import type { MediaArtifactRef } from '../../types'
import { mediaBlockPresentation } from './mediaDisplay'

function image(id: string): MediaArtifactRef {
  return {
    id,
    kind: 'image',
    mime: 'image/png',
    name: `${id}.png`,
    relPath: `memory/media/2026-06/${id}.png`,
    originalPath: `/tmp/${id}.png`,
  }
}

describe('media display helpers', () => {
  it('gives inline media blocks an explicit card label', () => {
    expect(mediaBlockPresentation([image('one'), image('two')])).toEqual({
      title: '媒体产物',
      detail: '2 张图片',
    })
  })
})
