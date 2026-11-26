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
    <InputGroupAddon v-if="clean_suffix" class="shrink-0 whitespace-nowrap" aria-label="固定后缀">
      {{ clean_suffix }}
    </InputGroupAddon>
  </InputGroup>
</template>

<script setup lang="ts">
import { link_file_name_illegal_chars } from '@shared/content-markdown'

defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{
  modelValue: string
  suffix?: string
  disabled?: boolean
}>(), { suffix: '', disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
// A raw pasted name can put illegal characters inside the locked extension
// (`.png:`, `.p n g`); the locked part is filtered just like the editable one.
const clean_suffix = computed(() => props.suffix.replace(link_file_name_illegal_chars, '_'))
</script>
