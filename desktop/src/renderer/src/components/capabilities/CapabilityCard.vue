<script setup lang="ts">
import type { CapabilityDisplayItem } from '../../capabilities/capabilityProjection'
import { attachmentIcon, navIcon, toolIcon } from '../../icons'

const props = defineProps<{
  item: CapabilityDisplayItem
  active?: boolean
}>()

const emit = defineEmits<{
  select: [item: CapabilityDisplayItem]
}>()

function iconFor(item: CapabilityDisplayItem) {
  if (item.kind === 'skill') return toolIcon('skill')
  if (item.kind === 'tool') return toolIcon(item.name)
  if (item.kind === 'mcp') return navIcon('mcp')
  if (item.kind === 'workspace') return navIcon('project')
  return attachmentIcon('document', undefined, item.name)
}
</script>

<template>
  <article
    class="capability-card"
    :class="{ active: props.active }"
    :data-kind="props.item.kind"
    :data-tone="props.item.tone"
    role="button"
    tabindex="0"
    @click="emit('select', props.item)"
    @keydown.enter.prevent="emit('select', props.item)"
    @keydown.space.prevent="emit('select', props.item)"
  >
    <div class="capability-card-head">
      <span class="capability-card-icon" aria-hidden="true">
        <component :is="iconFor(props.item)" :size="18" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="capability-card-name">{{ props.item.title }}</div>
        <div class="capability-card-desc">{{ props.item.description }}</div>
      </div>
    </div>
    <div class="capability-card-footer">
      <span
        v-for="badge in props.item.badges"
        :key="`${props.item.id}:${badge.label}`"
        class="badge capability-tag"
        :class="badge.tone || props.item.tone"
      >
        {{ badge.label }}
      </span>
    </div>
    <div v-if="props.item.meta" class="capability-card-path">
      {{ props.item.meta }}
    </div>
  </article>
</template>
