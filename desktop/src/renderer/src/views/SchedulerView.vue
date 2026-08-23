<script setup lang="ts">
import { ref } from 'vue'
import { useAppContext } from '../composables/useAppContext'
import SchedulerPanel from '../components/panels/SchedulerPanel.vue'
import { actionIcons } from '../icons'

const ctx = useAppContext()
const schedulerPanel = ref<InstanceType<typeof SchedulerPanel> | null>(null)
</script>

<template>
  <section class="main-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>定时任务</h1>
        <p>本地定时任务、运行历史与自动化入口</p>
      </div>
      <div class="view-head-actions">
        <button
          class="tool-button asset-button refresh-action"
          title="刷新"
          @click="ctx.refreshAll()"
        >
          <component :is="actionIcons.refresh" class="action-icon" :size="16" />
          <span>刷新</span>
        </button>
        <button
          class="tool-button asset-button primary-action"
          title="新增任务"
          @click="schedulerPanel?.openCreate()"
        >
          <component :is="actionIcons.new" class="action-icon" :size="16" />
          <span>新增任务</span>
        </button>
      </div>
    </header>
    <div class="view-body view-body-fill">
      <SchedulerPanel ref="schedulerPanel" />
    </div>
  </section>
</template>
