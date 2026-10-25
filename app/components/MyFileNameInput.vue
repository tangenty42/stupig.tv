<template>
  <InputGroup class="w-full">
    <MyFilteredInput
      v-bind="$attrs"
      :model-value="modelValue"
      :filter="link_file_name_illegal_chars"
      :disabled="disabled"
      class="min-w-0 w-full"
      @update:model-value="emit('update:modelValue', $event)"
    />
    <InputGroupAddon v-if="suffix" class="shrink-0 whitespace-nowrap" aria-label="固定后缀">
      {{ suffix }}
    </InputGroupAddon>
  </InputGroup>
</template>

<script setup lang="ts">
import { link_file_name_illegal_chars } from '@shared/content-markdown'

defineOptions({ inheritAttrs: false })
withDefaults(defineProps<{
  modelValue: string
  suffix?: string
  disabled?: boolean
}>(), { suffix: '', disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>
