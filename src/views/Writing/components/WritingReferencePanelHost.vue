<template>
  <OutlinePanel
    v-if="toolId === 'outline'"
    ref="panelRef"
    :title="title || REFERENCE_PANEL_TITLES.outline"
    :book-id="bookId"
    :panel-mode="panelMode"
    :hide-header="hideHeader"
    @close="emit('close')"
    @popout="emit('popout')"
    @dock="emit('dock')"
  />
  <CharacterPanel
    v-else-if="toolId === 'character'"
    ref="panelRef"
    :title="title || REFERENCE_PANEL_TITLES.character"
    :book-id="bookId"
    :panel-mode="panelMode"
    :hide-header="hideHeader"
    @close="emit('close')"
    @popout="emit('popout')"
    @dock="emit('dock')"
    @lore-updated="emit('lore-updated')"
  />
  <SettingPanel
    v-else-if="toolId === 'settings'"
    ref="panelRef"
    :title="title || REFERENCE_PANEL_TITLES.settings"
    :book-id="bookId"
    :panel-mode="panelMode"
    :hide-header="hideHeader"
    @close="emit('close')"
    @popout="emit('popout')"
    @dock="emit('dock')"
    @lore-updated="emit('lore-updated')"
  />
  <TimelinePanel
    v-else-if="toolId === 'timeline'"
    ref="panelRef"
    :title="title || REFERENCE_PANEL_TITLES.timeline"
    :book-id="bookId"
    :panel-mode="panelMode"
    :hide-header="hideHeader"
    @close="emit('close')"
    @popout="emit('popout')"
    @dock="emit('dock')"
  />
  <StorylinePanel
    v-else-if="toolId === 'storyline'"
    ref="panelRef"
    :title="title || REFERENCE_PANEL_TITLES.storyline"
    :book-id="bookId"
    :panel-mode="panelMode"
    :hide-header="hideHeader"
    @close="emit('close')"
    @popout="emit('popout')"
    @dock="emit('dock')"
  />
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'

// 五个面板各 ~1400 行（大纲/设定还拽着富文本编辑器），同步引入会把它们
// 全部打进写作页首包（此前单 chunk 914KB）。按面板懒加载：点开哪个装哪个。
const OutlinePanel = defineAsyncComponent(() => import('./OutlinePanel.vue'))
const CharacterPanel = defineAsyncComponent(() => import('./CharacterPanel.vue'))
const SettingPanel = defineAsyncComponent(() => import('./SettingPanel.vue'))
const TimelinePanel = defineAsyncComponent(() => import('./TimelinePanel.vue'))
const StorylinePanel = defineAsyncComponent(() => import('./StorylinePanel.vue'))
import {
  REFERENCE_PANEL_TITLES,
  type ReferencePanelMode,
  type ReferencePanelToolId,
} from './reference-panel'

interface PanelExpose {
  flushPendingSave?: () => Promise<void | boolean>
}

const props = defineProps<{
  toolId: ReferencePanelToolId
  title?: string
  bookId?: string | number
  panelMode?: ReferencePanelMode
  hideHeader?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'popout'): void
  (e: 'dock'): void
  (e: 'lore-updated'): void
}>()

const panelRef = ref<PanelExpose | null>(null)
const panelMode = computed(() => props.panelMode || 'side')

const flushPendingSave = async () => {
  return await panelRef.value?.flushPendingSave?.()
}

defineExpose({
  flushPendingSave,
})
</script>
