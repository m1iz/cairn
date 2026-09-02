<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowLeft, ArrowRight, PanelLeft } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { windowAction } from '../../api/backend'

type MenuId = 'file' | 'edit' | 'view' | 'window'
type MenuAction =
  | 'new-chat'
  | 'reload'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'toggle-sidebar'
  | 'minimize'
  | 'toggle-maximize'
  | 'close'
  | 'quit'

const router = useRouter()
const isWindows =
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
const openMenu = ref<MenuId | null>(null)
const chromeBar = ref<HTMLElement | null>(null)

const menus: Array<{
  id: MenuId
  label: string
  items: Array<{ label: string; action: MenuAction }>
}> = [
  {
    id: 'file',
    label: '文件',
    items: [
      { label: '新建对话', action: 'new-chat' },
      { label: '重新加载', action: 'reload' },
      { label: '退出 Cairn', action: 'quit' },
    ],
  },
  {
    id: 'edit',
    label: '编辑',
    items: [
      { label: '撤销', action: 'undo' },
      { label: '重做', action: 'redo' },
      { label: '剪切', action: 'cut' },
      { label: '复制', action: 'copy' },
      { label: '粘贴', action: 'paste' },
      { label: '全选', action: 'select-all' },
    ],
  },
  {
    id: 'view',
    label: '视图',
    items: [{ label: '切换侧栏', action: 'toggle-sidebar' }],
  },
  {
    id: 'window',
    label: '窗口',
    items: [
      { label: '最小化', action: 'minimize' },
      { label: '最大化 / 还原', action: 'toggle-maximize' },
      { label: '关闭窗口', action: 'close' },
    ],
  },
]

function toggleMenu(id: MenuId) {
  openMenu.value = openMenu.value === id ? null : id
}

function closeMenuFromOutside(event: PointerEvent) {
  if (!openMenu.value || chromeBar.value?.contains(event.target as Node)) return
  openMenu.value = null
}

function closeMenuFromKeyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') openMenu.value = null
}

onMounted(() => {
  document.addEventListener('pointerdown', closeMenuFromOutside)
  document.addEventListener('keydown', closeMenuFromKeyboard)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeMenuFromOutside)
  document.removeEventListener('keydown', closeMenuFromKeyboard)
})

function dispatch(name: string) {
  window.dispatchEvent(new Event(name))
}

async function runAction(action: MenuAction) {
  openMenu.value = null
  if (action === 'new-chat' || action === 'toggle-sidebar') {
    dispatch(`cairn:${action}`)
    return
  }
  if (action === 'reload') {
    window.location.reload()
    return
  }
  if (
    action === 'undo' ||
    action === 'redo' ||
    action === 'cut' ||
    action === 'copy' ||
    action === 'paste' ||
    action === 'select-all'
  ) {
    document.execCommand(action === 'select-all' ? 'selectAll' : action)
    return
  }
  await windowAction(action)
}
</script>

<template>
  <header v-if="isWindows" ref="chromeBar" class="desktop-chrome-bar">
    <div class="desktop-chrome-leading">
      <button
        class="desktop-chrome-icon-button"
        type="button"
        aria-label="切换侧栏"
        title="切换侧栏"
        @click="dispatch('cairn:toggle-sidebar')"
      >
        <PanelLeft :size="16" />
      </button>
      <button
        class="desktop-chrome-icon-button"
        type="button"
        aria-label="后退"
        title="后退"
        @click="router.go(-1)"
      >
        <ArrowLeft :size="18" />
      </button>
      <button
        class="desktop-chrome-icon-button"
        type="button"
        aria-label="前进"
        title="前进"
        @click="router.go(1)"
      >
        <ArrowRight :size="18" />
      </button>
    </div>

    <nav class="desktop-chrome-menu" aria-label="应用菜单">
      <div
        v-for="menu in menus"
        :key="menu.id"
        class="desktop-chrome-menu-item"
      >
        <button
          class="desktop-chrome-menu-button"
          type="button"
          :aria-expanded="openMenu === menu.id"
          aria-haspopup="menu"
          @click="toggleMenu(menu.id)"
        >
          {{ menu.label }}
        </button>
        <div
          v-if="openMenu === menu.id"
          class="desktop-chrome-menu-popover"
          role="menu"
        >
          <button
            v-for="item in menu.items"
            :key="item.action"
            type="button"
            role="menuitem"
            @click="runAction(item.action)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
    </nav>
    <div class="desktop-chrome-spacer" />
  </header>
</template>
