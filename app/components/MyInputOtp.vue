<template>
  <IconField>
    <InputIcon><MyIcon name="lucide:mail" /></InputIcon>
    <input
      :id="id"
      :value="modelValue"
      class="otp-input p-inputtext p-variant-filled p-component"
      :class="{ 'p-invalid': invalid }"
      type="text"
      inputmode="numeric"
      :maxlength="length"
      autocomplete="one-time-code"
      :placeholder="placeholder ?? ''"
      :aria-invalid="invalid ? 'true' : undefined"
      :aria-describedby="ariaDescribedby"
      @input="on_input"
      @keydown="on_keydown"
      @paste="on_paste"
      @blur="on_blur"
    >
  </IconField>
</template>

<script lang="ts" setup>
const props = withDefaults(defineProps<{
  modelValue?: string
  placeholder?: string
  length?: number
  invalid?: boolean
  id?: string
  ariaDescribedby?: string
}>(), {
  modelValue: '',
  length: 6,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'input': [event: { target: { value: string } }]
  'change': [event: { target: { value: string } }]
  'blur': [event: { target: { value: string } }]
}>()

function emit_value(value: string, _event: Event) {
  const fake = { target: { value } }
  emit('update:modelValue', value)
  emit('input', fake)
  emit('change', fake)
}

function on_input(event: Event) {
  const el = event.target as HTMLInputElement
  const cleaned = el.value.replace(/\D/g, '').slice(0, props.length)
  el.value = cleaned
  emit_value(cleaned, event)
}

function on_keydown(event: KeyboardEvent) {
  if (! event.key || event.ctrlKey || event.metaKey || event.key === 'Tab' || event.key === 'Enter' || event.key === 'Backspace' || event.key === 'Delete' || event.key.startsWith('Arrow')) {
    return
  }
  if (! /^\d$/.test(event.key)) {
    event.preventDefault()
  }
}

function on_paste(event: ClipboardEvent) {
  event.preventDefault()
  const paste = (event.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, props.length)
  if (paste.length) {
    const el = event.target as HTMLInputElement
    el.value = paste
    emit_value(paste, event)
  }
}

function on_blur(event: Event) {
  const value = (event.target as HTMLInputElement).value
  emit('blur', { target: { value } })
}
</script>

<style scoped>
  .otp-input:not(:placeholder-shown) {
    letter-spacing: 0.75rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .otp-input:placeholder-shown {
    color: var(--p-inputtext-color) !important;
  }
</style>
