<template>
  <Dialog
    :visible="visible"
    modal
    header="生产懒加载弹窗"
    append-to="body"
    class="w-64"
    :style="{ width: '321px' }"
    :pt="{ content: { class: '!p-0' } }"
    @update:visible="value => ! value && emit('close')"
  >
    <div class="production-dialog-content">
      延迟 CSS 到达后仍使用实际应用主题
    </div>
  </Dialog>
</template>

<script setup lang="ts">
defineProps<{ visible: boolean }>()
const emit = defineEmits<{ close: [] }>()
</script>

<style scoped>
.production-dialog-content {
  min-height: 2rem;
}
</style>
