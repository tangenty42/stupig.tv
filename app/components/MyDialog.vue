<template>
  <Dialog
    v-model:visible="visible"
    modal
    :header="header"
    :aria-label="header"
    :draggable="false"
    :closable="props.closable ?? (! props.pending)"
    :dismissable-mask="props.closable ?? (! props.pending)"
    class="w-full"
    :class="panel_class"
  >
    <template v-if="$slots.default" #default>
      <MyHeightTransition>
        <slot />
      </MyHeightTransition>
    </template>

    <template v-if="$slots.header" #header>
      <slot name="header" />
    </template>

    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
    </template>
  </Dialog>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  visible: boolean
  header?: string
  pending?: boolean
  closable?: boolean
  /** Tailwind max-width class for the panel; the default suits ordinary forms. */
  panel_class?: string
}>(), {
  pending: false,
  closable: true,
  panel_class: 'max-w-md',
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

const visible = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value),
})
</script>
