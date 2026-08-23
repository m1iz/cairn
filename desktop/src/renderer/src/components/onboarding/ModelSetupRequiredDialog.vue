<script setup lang="ts">
import { computed } from 'vue'
import { actionIcons, navIcon } from '../../icons'
import BrandMark from '../brand/BrandMark.vue'
import { buildModelSetupDialogContent } from './modelSetupDialogModel'

const props = defineProps<{
  open: boolean
  message: string
}>()

const emit = defineEmits<{
  close: []
  configure: []
}>()

const content = computed(() => buildModelSetupDialogContent(props.message))
const modelIcon = navIcon('model')
const closeIcon = actionIcons.close
</script>

<template>
  <div
    v-if="open"
    class="onboarding-backdrop model-setup-backdrop"
    role="presentation"
  >
    <section
      class="model-setup-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="model-setup-title"
      aria-describedby="model-setup-description"
    >
      <button
        class="model-setup-close"
        type="button"
        title="关闭"
        aria-label="关闭"
        @click="emit('close')"
      >
        <component :is="closeIcon" :size="16" />
      </button>

      <div class="model-setup-copy">
        <header class="model-setup-head">
          <div class="model-setup-wordmark" :aria-label="content.brandAlt">
            <BrandMark :size="30" />
            <span>Cairn</span>
          </div>
        </header>

        <div class="model-setup-intro">
          <h2 id="model-setup-title">{{ content.title }}</h2>
          <p id="model-setup-description">{{ content.subtitle }}</p>
        </div>

        <div class="model-setup-status" role="status">
          <p>{{ content.status }}</p>
        </div>

        <footer class="model-setup-actions">
          <p>{{ content.helperText }}</p>
          <div class="model-setup-action-row">
            <button class="tool-button" type="button" @click="emit('close')">
              {{ content.secondaryAction }}
            </button>
            <button
              class="tool-button ink asset-button primary-action"
              type="button"
              @click="emit('configure')"
            >
              <component :is="modelIcon" class="action-icon" :size="16" />
              <span>{{ content.primaryAction }}</span>
            </button>
          </div>
        </footer>
      </div>

      <aside
        class="model-setup-visual"
        aria-label="Cairn product preview"
      >
        <div class="model-setup-cairn" :aria-label="content.heroAlt">
          <BrandMark size="clamp(132px, 25vw, 220px)" />
          <p>Choose a model. Keep control.</p>
        </div>
      </aside>
    </section>
  </div>
</template>
