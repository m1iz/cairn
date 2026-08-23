<script setup lang="ts">
import { computed } from 'vue'
import logoMarkUrl from '../../../../../../assets/brand/cairn-mark.svg'

const props = withDefaults(
  defineProps<{
    size?: number | string
    alt?: string
  }>(),
  {
    size: 24,
    alt: '',
  },
)

const dimension = computed(() =>
  typeof props.size === 'number' ? `${props.size}px` : props.size,
)
</script>

<template>
  <img
    :src="logoMarkUrl"
    class="brand-mark"
    :alt="props.alt"
    :aria-hidden="props.alt ? undefined : 'true'"
    :style="{ width: dimension, height: dimension }"
    draggable="false"
  />
</template>
