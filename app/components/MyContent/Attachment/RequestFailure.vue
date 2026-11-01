<template>
  <MyDialog :visible="visible" :header="failure.source === 'upload' ? '上传请求失败' : '附件操作失败'" :pending="pending" :closable="! pending" @update:visible="$emit('update:visible', $event)">
    <p class="whitespace-pre-wrap break-words">
      {{ failure.message }}
    </p>
    <template #footer>
      <Button label="关闭" severity="secondary" text :disabled="pending" @click="$emit('update:visible', false)" />
      <Button label="重试" :loading="pending" :disabled="pending" @click="$emit('retry', failure.source)" />
    </template>
  </MyDialog>
</template>

<script setup lang="ts">
const props = defineProps<{ visible: boolean, operationError: string, uploadError: string, pending: boolean }>()
defineEmits<{ 'update:visible': [value: boolean], 'retry': [source: 'operation' | 'upload'] }>()
const failure = ref<{ source: 'operation' | 'upload', message: string }>({ source: 'operation', message: '' })
// Retain the explanation while retry clears the live error and awaits its receipt.
watch(() => [props.operationError, props.uploadError, props.pending], () => {
  if (props.pending && failure.value.message)
    return
  if (props.operationError)
    failure.value = { source: 'operation', message: props.operationError }
  else if (props.uploadError)
    failure.value = { source: 'upload', message: props.uploadError }
}, { immediate: true, flush: 'sync' })
</script>
