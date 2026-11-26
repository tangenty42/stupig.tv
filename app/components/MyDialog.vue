<template>
  <Dialog
    :visible="visible"
    modal
    :header="header"
    :aria-label="header"
    :draggable="false"
    :closable="can_dismiss"
    :dismissable-mask="can_dismiss"
    class="w-full"
    :class="fullscreen ? '!m-0 !h-dvh !max-h-dvh !max-w-none !rounded-none' : panel_class"
    :pt="fullscreen ? { header: { class: '!px-4 !py-3 shrink-0 border-b border-slate-200 dark:border-slate-700' }, content: { class: '!p-0 flex min-h-0 flex-1 flex-col overflow-hidden' }, footer: { class: '!p-3 shrink-0 border-t border-slate-200 dark:border-slate-700' } } : undefined"
    @update:visible="update_visible"
    @after-hide="emit('after-hide')"
  >
    <template v-if="$slots.default" #default>
      <slot v-if="fullscreen" />
      <MyHeightTransition v-else>
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
  fullscreen?: boolean
}>(), {
  pending: false,
  closable: true,
  panel_class: 'max-w-md',
  fullscreen: false,
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'after-hide': []
}>()

const can_dismiss = computed(() => props.closable && ! props.pending)

function update_visible(value: boolean) {
  // PrimeVue binds its Escape listener when the dialog opens. Keep the listener
  // in place and check the current state here, including after pending changes.
  if (value || can_dismiss.value)
    emit('update:visible', value)
}
</script>
