import type { MediaArtifactRef } from '../../types'

export function mediaBlockPresentation(items: MediaArtifactRef[]) {
  const imageCount = items.filter((item) => item.kind === 'image').length
  const total = imageCount || items.length
  const unit = imageCount === total ? '张图片' : '个文件'
  return {
    title: '媒体产物',
    detail: `${total} ${unit}`,
  }
}
