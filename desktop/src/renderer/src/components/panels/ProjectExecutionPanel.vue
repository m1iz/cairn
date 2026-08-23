<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAppContext } from '../../composables/useAppContext'
import { planExecutionSummary } from '../../runtime/handlers/plans'
import {
  activeProjectPlan,
  reviewerTaskId,
} from '../../runtime/projectExecution'
import ReviewerTranscriptDrawer from './ReviewerTranscriptDrawer.vue'
import GoalCard from '../chat/GoalCard.vue'
import { activeGoalForSession } from '../../runtime/selectors'
import {
  toGoalCardViewModel,
  type GoalCardAction,
} from '../../runtime/goalRender'

const ctx = useAppContext()
const plans = computed(() => ctx.planProjection.plans || [])
const plan = computed(() => activeProjectPlan(plans.value))
const summary = computed(() => planExecutionSummary(plan.value))
const reviewerTask = computed(() => reviewerTaskId(plan.value))
const steps = computed(() => plan.value?.steps || [])
const drawerOpen = ref(false)
const goal = computed(() => {
  const projected = activeGoalForSession(
    ctx.goalProjection,
    ctx.sessionId.value,
  )
  if (projected) return projected
  const candidates = [
    ...Object.values(ctx.goalProjection.byId),
    ...(ctx.boot.value?.goals?.recent || []),
  ]
    .filter((item) => item.sessionId === ctx.sessionId.value)
    .sort(
      (a, b) =>
        Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || '') ||
        b.lastEventSeq - a.lastEventSeq,
    )
  return candidates[0] || null
})
const goalModel = computed(() => {
  if (!goal.value) return null
  return toGoalCardViewModel({
    goal: goal.value,
    plan:
      plans.value.find((item) => item.id === goal.value?.currentPlanId) || null,
    evidence: ctx.goalProjection.latestEvidenceByGoal[goal.value.id],
    gate: ctx.goalProjection.latestGateByGoal[goal.value.id],
  })
})

function focusPlan(planId: string) {
  const target = document.querySelector<HTMLElement>(
    `[data-plan-id="${CSS.escape(planId)}"]`,
  )
  if (!target) return
  target.focus({ preventScroll: true })
  const scroller = target.parentElement
  if (scroller) scroller.scrollTop = Math.max(0, target.offsetTop - 12)
}

function runGoalAction(payload: { goalId: string; action: GoalCardAction }) {
  void ctx.runSafely(async () => {
    await ctx.runGoalAction(payload.goalId, payload.action)
  })
}
</script>

<template>
  <div class="panel project-execution-panel">
    <GoalCard
      v-if="goalModel"
      :key="goalModel.id"
      :model="goalModel"
      @action="runGoalAction"
      @focus-plan="focusPlan"
    />
    <div v-if="!plan && !goalModel" class="panel-empty">
      暂无进行中的 Goal 或项目执行计划
    </div>
    <template v-else>
      <section
        v-if="plan"
        class="pe-section pe-plan-head"
        :data-plan-id="plan.id"
        tabindex="-1"
      >
        <h3>{{ plan.title }}</h3>
        <span class="pe-status">{{ plan.status }}</span>
      </section>

      <section v-if="plan" class="pe-section pe-steps">
        <h3>计划步骤</h3>
        <ol class="pe-step-list">
          <li v-for="step in steps" :key="step.id" :data-status="step.status">
            <span class="pe-step-status">{{ step.status }}</span>
            <span class="pe-step-title">{{ step.title }}</span>
          </li>
        </ol>
      </section>

      <section
        v-if="plan"
        class="pe-section pe-verification"
        :data-status="summary.independentVerificationStatus"
      >
        <h3>独立复核 · {{ summary.independentVerificationStatus }}</h3>
        <p v-if="summary.independentVerificationSummary">
          {{ summary.independentVerificationSummary }}
        </p>
        <ul
          v-if="summary.independentVerificationCommands.length"
          class="pe-commands"
        >
          <li v-for="cmd in summary.independentVerificationCommands" :key="cmd">
            <code>{{ cmd }}</code>
          </li>
        </ul>
        <button
          v-if="reviewerTask"
          class="tool-button"
          @click="drawerOpen = true"
        >
          打开复核 transcript
        </button>
      </section>

      <section
        v-if="plan && summary.failedVerificationSummary"
        class="pe-section pe-failed"
      >
        <h3>验证失败</h3>
        <p>{{ summary.failedVerificationSummary }}</p>
      </section>

      <section
        v-if="plan && summary.blockedReason"
        class="pe-section pe-blocked"
      >
        <h3>阻塞原因</h3>
        <p>{{ summary.blockedReason }}</p>
      </section>

      <section
        v-if="plan && summary.openQuestionsCount"
        class="pe-section pe-questions"
      >
        <h3>待答问题：{{ summary.openQuestionsCount }}</h3>
      </section>

      <ReviewerTranscriptDrawer
        v-if="reviewerTask"
        v-model:open="drawerOpen"
        :task-id="reviewerTask"
      />
    </template>
  </div>
</template>
