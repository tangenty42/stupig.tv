<template>
  <InputText
    ref="input_component"
    :model-value="modelValue"
    @update:model-value="on_update"
    @compositionstart="ime_composing = true"
    @compositionend="on_composition_end"
  />
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  modelValue: string
  /** Global regex whose matches are replaced in the model; raw text is kept during IME composition. */
  filter?: RegExp | null
  replacement?: string
}>(), {
  filter: null,
  replacement: '_',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const input_component = ref<{ $el: HTMLInputElement } | null>(null)
const ime_composing = ref(false)

function sanitize(value: string) {
  return props.filter ? value.replace(props.filter, props.replacement) : value
}

function emit_filtered(raw: string) {
  const filtered = sanitize(raw)
  const el = input_component.value?.$el
  const start = el?.selectionStart ?? 0
  const end = el?.selectionEnd ?? 0
  emit('update:modelValue', filtered)
  // Vue re-patches el.value when the model changes, which moves the cursor
  // to the end; put it back where the edit happened.
  if (filtered !== raw && el) {
    nextTick(() => el.setSelectionRange(Math.min(start, filtered.length), Math.min(end, filtered.length)))
  }
}

function on_update(value: string | undefined) {
  if (ime_composing.value) {
    emit('update:modelValue', value ?? '')
    return
  }
  emit_filtered(value ?? '')
}

function on_composition_end() {
  ime_composing.value = false
  // The trailing input event normally sanitizes; this covers IMEs that end
  // a composition without one.
  emit_filtered(props.modelValue)
}
</script>
