<script setup lang="ts">
import { ref, watch } from 'vue'
import { goalIcons } from '../../icons'
import type {
  GoalCardAction,
  GoalCardViewModel,
} from '../../runtime/goalRender'
import GoalAcceptanceMatrix from './GoalAcceptanceMatrix.vue'

const props = defineProps<{ model: GoalCardViewModel }>()
const emit = defineEmits<{
  action: [payload: { goalId: string; action: GoalCardAction }]
  'focus-plan': [planId: string]
}>()

const confirmCancel = ref(false)

watch(
  () => [props.model.id, props.model.terminal] as const,
  () => {
    confirmCancel.value = false
  },
)

function actionLabel(action: GoalCardAction) {
  if (action === 'pause') return '暂停 Goal'
  if (action === 'resume') return '恢复 Goal'
  return confirmCancel.value ? '确认取消 Goal' : '取消 Goal'
}

function actionIcon(action: GoalCardAction) {
  if (action === 'pause') return goalIcons.pause
  if (action === 'resume') return goalIcons.resume
  return goalIcons.cancel
}

function requestAction(action: GoalCardAction) {
  if (action === 'cancel' && !confirmCancel.value) {
    confirmCancel.value = true
    return
  }
  confirmCancel.value = false
  emit('action', { goalId: props.model.id, action })
}
</script>

<template>
  <article
    class="goal-card"
    :data-terminal="model.terminal"
    :aria-label="`Goal：${model.outcome}`"
  >
    <header class="goal-card-head">
      <div class="goal-card-title">
        <span class="goal-kicker">
          <component :is="goalIcons.goal" :size="14" aria-hidden="true" />
          GOAL
        </span>
        <h3>{{ model.outcome }}</h3>
      </div>
      <div class="goal-status-stack" aria-label="Goal 状态">
        <strong>{{ model.statusLabel }}</strong>
        <span>{{ model.phaseLabel }} · {{ model.cycleLabel }}</span>
      </div>
    </header>

    <button
      v-if="model.currentPlan"
      type="button"
      class="goal-plan-link"
      :aria-label="`聚焦计划：${model.currentPlan.title}`"
      @click="emit('focus-plan', model.currentPlan.id)"
    >
      <component :is="goalIcons.plan" :size="16" aria-hidden="true" />
      <span>
        <small>当前计划</small>
        <strong>{{ model.currentPlan.title }}</strong>
        <em v-if="model.currentPlan.activeStep">
          正在执行：{{ model.currentPlan.activeStep }}
        </em>
      </span>
      <component :is="goalIcons.focus" :size="15" aria-hidden="true" />
    </button>

    <GoalAcceptanceMatrix :rows="model.acceptanceRows" />

    <p v-if="model.notice" class="goal-notice" role="status">
      <component :is="goalIcons.notice" :size="15" aria-hidden="true" />
      {{ model.notice }}
    </p>

    <footer class="goal-card-footer">
      <p>Goal 沿用当前权限模式，不会自动扩大操作权限。</p>
      <div v-if="model.actions.length" class="goal-actions">
        <button
          v-if="confirmCancel"
          type="button"
          class="goal-action"
          @click="confirmCancel = false"
        >
          返回
        </button>
        <button
          v-for="action in model.actions"
          :key="action"
          type="button"
          class="goal-action"
          :class="{ danger: action === 'cancel' && confirmCancel }"
          :aria-label="actionLabel(action)"
          @click="requestAction(action)"
        >
          <component :is="actionIcon(action)" :size="15" aria-hidden="true" />
          {{ actionLabel(action) }}
        </button>
      </div>
    </footer>
  </article>
</template>
