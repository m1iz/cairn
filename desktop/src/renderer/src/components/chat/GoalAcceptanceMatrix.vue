<script setup lang="ts">
import type { GoalAcceptanceRow } from '../../runtime/goalRender'
import { goalIcons } from '../../icons'

defineProps<{ rows: GoalAcceptanceRow[] }>()

function verdictLabel(verdict: GoalAcceptanceRow['verdict']) {
  if (verdict === 'pass') return 'PASS'
  if (verdict === 'fail') return 'FAIL'
  return '缺证据'
}

function verdictIcon(verdict: GoalAcceptanceRow['verdict']) {
  if (verdict === 'pass') return goalIcons.pass
  if (verdict === 'fail') return goalIcons.fail
  return goalIcons.missing
}
</script>

<template>
  <section class="goal-acceptance" aria-labelledby="goal-acceptance-title">
    <header class="goal-section-head">
      <h4 id="goal-acceptance-title">验收矩阵</h4>
      <span>{{ rows.length }} 项</span>
    </header>
    <div v-if="rows.length" class="goal-acceptance-list">
      <article
        v-for="row in rows"
        :key="row.id"
        class="goal-acceptance-row"
        :data-verdict="row.verdict"
      >
        <component
          :is="verdictIcon(row.verdict)"
          class="goal-acceptance-icon"
          :size="15"
          aria-hidden="true"
        />
        <div class="goal-acceptance-copy">
          <strong>{{ row.description }}</strong>
          <details v-if="row.evidence">
            <summary>{{ row.evidence }}</summary>
            <p>{{ row.evidence }}</p>
          </details>
          <p v-else>暂无可展示的证据摘要</p>
        </div>
        <span class="goal-verdict-label">{{ verdictLabel(row.verdict) }}</span>
      </article>
    </div>
    <p v-else class="goal-empty-copy">验收条件尚未定义。</p>
  </section>
</template>
