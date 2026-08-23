<script setup lang="ts">
import { computed } from 'vue'
import type { MediaArtifactRef } from '../../types'
import { attachmentIcon } from '../../icons'
import MediaPreviewGrid from './MediaPreviewGrid.vue'
import { mediaBlockPresentation } from './mediaDisplay'

const props = defineProps<{ items: MediaArtifactRef[] }>()

const mediaIcon = attachmentIcon('image')
const presentation = computed(() => mediaBlockPresentation(props.items))
</script>

<template>
  <div class="timeline-node media-node">
    <div class="media-node-head">
      <span class="media-node-icon" aria-hidden="true">
        <component :is="mediaIcon" :size="15" />
      </span>
      <span class="media-node-main">
        <strong>{{ presentation.title }}</strong>
        <small>{{ presentation.detail }}</small>
      </span>
    </div>
    <MediaPreviewGrid :items="props.items" />
  </div>
</template>
