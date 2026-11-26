<template>
  <MyDialog :visible="visible" header="选择文件夹展开方式" @update:visible="! $event && emit('cancel')">
    <p class="mb-3 text-sm">
      适用于本次选中的所有文件夹：
    </p>
    <div class="grid gap-2">
      <Button v-for="choice in choices" :key="choice.mode" :label="choice.label" severity="secondary" outlined @click="emit('choose', choice.mode)">
        <template #icon>
          <MyIcon :name="choice.icon" />
        </template>
      </Button>
    </div>
  </MyDialog>
</template>

<script setup lang="ts">
import type { FolderMarkdownMode } from '~/features/content/attachments/drag'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{ choose: [mode: FolderMarkdownMode], cancel: [] }>()
const choices = [
  { mode: 'folder', label: '仅文件夹', icon: 'lucide:folder' },
  { mode: 'files', label: '展开直属文件', icon: 'lucide:files' },
  { mode: 'images', label: '展开直属图片', icon: 'lucide:images' },
] as const
</script>
