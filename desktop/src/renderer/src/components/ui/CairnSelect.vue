<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'

export interface CairnSelectOption {
  value: string
  label: string
  description?: string
  tags?: string[]
  disabled?: boolean
}

const props = defineProps<{
  modelValue: string
  options: CairnSelectOption[]
  placeholder?: string
  ariaLabel?: string
  variant?: 'default' | 'plain'
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const open = ref(false)
const activeIndex = ref(0)
const selected = computed(() =>
  props.options.find((option) => option.value === props.modelValue),
)

function enabledIndex(start: number, delta: number): number {
  if (!props.options.length) return -1
  let index = start
  for (let count = 0; count < props.options.length; count += 1) {
    index = (index + delta + props.options.length) % props.options.length
    if (!props.options[index]?.disabled) return index
  }
  return -1
}

function show() {
  open.value = true
  const selectedIndex = props.options.findIndex(
    (option) => option.value === props.modelValue && !option.disabled,
  )
  activeIndex.value = selectedIndex >= 0 ? selectedIndex : enabledIndex(-1, 1)
}

function choose(option: CairnSelectOption) {
  if (option.disabled) return
  emit('update:modelValue', option.value)
  open.value = false
  void nextTick(() => trigger.value?.focus())
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    open.value = false
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!open.value) show()
    else
      activeIndex.value = enabledIndex(
        activeIndex.value,
        event.key === 'ArrowDown' ? 1 : -1,
      )
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (!open.value) show()
    else {
      const option = props.options[activeIndex.value]
      if (option) choose(option)
    }
  }
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) open.value = false
}

watch(
  () => props.options,
  () => {
    if (activeIndex.value >= props.options.length) activeIndex.value = 0
  },
)

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onBeforeUnmount(() =>
  document.removeEventListener('pointerdown', onDocumentPointerDown),
)
</script>

<template>
  <div
    ref="root"
    class="cairn-select"
    :class="`is-${variant || 'default'}`"
    @keydown="onKeydown"
  >
    <button
      ref="trigger"
      type="button"
      class="cairn-select-trigger"
      aria-haspopup="listbox"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      @click="open ? (open = false) : show()"
    >
      <span class="cairn-select-copy">
        <strong>{{ selected?.label || placeholder || '请选择' }}</strong>
        <small v-if="selected?.description">{{ selected.description }}</small>
      </span>
      <ChevronDown :size="16" :class="{ 'rotate-180': open }" />
    </button>
    <div
      v-if="open"
      class="cairn-select-menu"
      :class="{ 'is-plain-menu': variant === 'plain' }"
      role="listbox"
    >
      <button
        v-for="(option, index) in options"
        :key="option.value"
        type="button"
        role="option"
        :disabled="option.disabled"
        :aria-selected="modelValue === option.value"
        :class="{ active: activeIndex === index }"
        @pointerenter="activeIndex = index"
        @click="choose(option)"
      >
        <span class="cairn-select-copy">
          <strong>{{ option.label }}</strong>
          <small v-if="option.description">{{ option.description }}</small>
          <span v-if="option.tags?.length" class="cairn-select-tags">
            <em v-for="tag in option.tags" :key="tag">{{ tag }}</em>
          </span>
        </span>
        <Check v-if="modelValue === option.value" :size="15" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.cairn-select {
  position: relative;
}
.cairn-select-trigger {
  display: flex;
  width: 100%;
  min-height: 3.6rem;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-lg);
  padding: 0.65rem 0.75rem;
  background: rgb(var(--bg-elevated));
  color: rgb(var(--fg));
  text-align: left;
  cursor: pointer;
}
.cairn-select-trigger:hover,
.cairn-select-trigger[aria-expanded='true'] {
  border-color: rgb(var(--border-strong));
  background: rgb(var(--bg-inset));
}
.cairn-select-trigger:focus-visible {
  outline: 2px solid rgb(var(--accent) / 0.5);
  outline-offset: 2px;
}
.cairn-select.is-plain .cairn-select-trigger {
  min-height: 0;
  border-color: transparent;
  border-radius: var(--radius-md);
  padding: 0.25rem 0.4rem;
  background: transparent;
}
.cairn-select.is-plain .cairn-select-trigger:hover,
.cairn-select.is-plain .cairn-select-trigger[aria-expanded='true'] {
  border-color: transparent;
  background: rgb(var(--bg-inset));
}
.cairn-select.is-plain .cairn-select-copy strong {
  font-size: var(--font-size-md);
}
.cairn-select-menu.is-plain-menu {
  right: auto;
  width: max-content;
  min-width: max(100%, 10.5rem);
  max-width: min(22rem, calc(100vw - 2rem));
}
.cairn-select-menu.is-plain-menu > button {
  white-space: nowrap;
}
.cairn-select-trigger > svg {
  flex: none;
  color: rgb(var(--fg-subtle));
  transition: transform 150ms ease;
}
.cairn-select-copy {
  display: block;
  min-width: 0;
}
.cairn-select-copy strong,
.cairn-select-copy small {
  display: block;
}
.cairn-select-copy strong {
  color: rgb(var(--fg));
  font-size: 0.82rem;
  font-weight: 700;
}
.cairn-select-copy small {
  margin-top: 0.2rem;
  color: rgb(var(--fg-subtle));
  font-size: 0.7rem;
  font-weight: 400;
  line-height: 1.45;
}
.cairn-select-menu {
  position: absolute;
  z-index: 90;
  top: calc(100% + 0.4rem);
  right: 0;
  left: 0;
  max-height: min(25rem, 55vh);
  overflow-y: auto;
  border: 1px solid rgb(var(--border-strong));
  border-radius: var(--radius-lg);
  padding: 0.3rem;
  background: rgb(var(--bg-elevated));
  box-shadow: var(--shadow-lg);
}
.cairn-select-menu > button {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  border: 0;
  border-radius: var(--radius-md);
  padding: 0.65rem 0.7rem;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.cairn-select-menu > button:hover,
.cairn-select-menu > button.active,
.cairn-select-menu > button[aria-selected='true'] {
  background: rgb(var(--bg-inset));
}
.cairn-select-menu > button:focus-visible {
  outline: 2px solid rgb(var(--accent) / 0.45);
  outline-offset: -2px;
}
.cairn-select-menu > button > svg {
  flex: none;
  color: rgb(var(--accent));
}
.cairn-select-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.4rem;
}
.cairn-select-tags em {
  border: 1px solid rgb(var(--border) / 0.75);
  border-radius: 999px;
  padding: 0.1rem 0.4rem;
  color: rgb(var(--fg-muted));
  font-size: 0.62rem;
  font-style: normal;
}
</style>
