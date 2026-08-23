<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ToolInfo } from '../../types'
import {
  toolCapability,
  type CapabilityDisplayItem,
} from '../../capabilities/capabilityProjection'
import { emptyIcons } from '../../icons'
import CapabilityCard from '../capabilities/CapabilityCard.vue'

const props = defineProps<{ tools: ToolInfo[] }>()
const filter = ref('')
const selectedName = ref('')
const detailOpen = ref(false)

const filtered = computed(() => {
  const query = filter.value.trim().toLowerCase()
  if (!query) return props.tools
  return props.tools.filter((tool) =>
    `${tool.name} ${tool.description}`.toLowerCase().includes(query),
  )
})
const toolItems = computed(() =>
  filtered.value.map((tool) => toolCapability(tool)),
)

const selectedTool = computed(
  () => props.tools.find((tool) => tool.name === selectedName.value) || null,
)

function openTool(tool: ToolInfo) {
  selectedName.value = tool.name
  detailOpen.value = true
}

function openToolItem(item: CapabilityDisplayItem) {
  const tool = props.tools.find((candidate) => candidate.name === item.name)
  if (!tool) return
  openTool(tool)
}

function paramNames(params?: Record<string, unknown>): string[] {
  if (!params || typeof params !== 'object') return []
  const props = (params as any).properties
  if (!props || typeof props !== 'object') return []
  return Object.keys(props)
}

function paramSchema(tool: ToolInfo) {
  if (!tool.parameters) return '{}'
  return JSON.stringify(tool.parameters, null, 2)
}
</script>

<template>
  <div
    class="panel-content capability-panel"
    :class="{ 'has-detail': detailOpen && selectedTool }"
  >
    <div class="panel-toolbar">
      <div class="filter-wrap">
        <input v-model="filter" placeholder="筛选工具" />
        <span v-if="filter" class="filter-badge">{{ filtered.length }}</span>
        <span v-else-if="props.tools.length" class="filter-badge"
          >共 {{ props.tools.length }} 个</span
        >
      </div>
    </div>

    <div class="capability-card-grid panel-scroll">
      <CapabilityCard
        v-for="item in toolItems"
        :key="item.id"
        :item="item"
        :active="selectedName === item.name"
        @select="openToolItem"
      />
      <div
        v-if="!filtered.length"
        class="empty-state illustrated-empty tool-empty"
      >
        <component :is="emptyIcons.tools" :size="64" :stroke-width="1" />
        <span>没有匹配的工具。</span>
      </div>
    </div>

    <aside v-if="detailOpen && selectedTool" class="capability-detail-drawer">
      <div class="capability-drawer-head">
        <div class="min-w-0">
          <h2>{{ selectedTool.name }}</h2>
          <p>
            {{
              selectedTool.source === 'mcp'
                ? `MCP · ${selectedTool.server || 'server'}`
                : '内建工具'
            }}
          </p>
        </div>
        <button class="icon-button" title="关闭" @click="detailOpen = false">
          ×
        </button>
      </div>

      <p class="capability-detail-copy">
        {{ selectedTool.description || '无描述' }}
      </p>

      <div class="capability-drawer-badges">
        <span class="badge" :class="selectedTool.read_only ? 'green' : 'red'">{{
          selectedTool.read_only ? '只读' : '可写'
        }}</span>
        <span v-if="selectedTool.concurrency_safe" class="badge green"
          >并发安全</span
        >
        <span v-if="selectedTool.exclusive" class="badge gold">独占</span>
        <span v-if="selectedTool.source === 'mcp'" class="badge blue">MCP</span>
      </div>

      <section class="capability-param-section">
        <div class="scheduler-history-head">
          <strong>参数</strong>
          <span>{{ paramNames(selectedTool.parameters).length }} 个</span>
        </div>
        <div
          v-if="paramNames(selectedTool.parameters).length"
          class="tool-param-list expanded"
        >
          <span
            v-for="p in paramNames(selectedTool.parameters)"
            :key="p"
            class="tool-param-chip"
            >{{ p }}</span
          >
        </div>
        <div v-else class="empty-note">这个工具没有声明参数。</div>
      </section>

      <pre class="capability-schema">{{ paramSchema(selectedTool) }}</pre>
    </aside>
  </div>
</template>
