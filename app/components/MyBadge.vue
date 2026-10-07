<template>
  <span :class="class_computed"><slot /></span>
</template>

<script lang="ts" setup>
const props = defineProps<{
  type?: 'info' | 'success' | 'warning' | 'error' | 'raw'
  outlined?: boolean
  button?: boolean
}>()

const class_computed = computed(() => {
  const base = 'badge'
  const type_class = `badge-${props.type ?? 'raw'}${props.outlined ? '-outlined' : ''}`
  return [base, type_class, ... (props.button ? ['badge-button'] : [])]
})
</script>

<style scoped>
  /* inline-flex (not inline): the pill's height then follows the line box
     instead of the font's ascent/descent, so it no longer stretches or
     shrinks with whichever CJK font the platform resolved, and the glyphs
     stay centred in it. */
  .badge {
    @apply
      inline-flex
      items-center
      rounded-full
      px-2
      py-1
      text-xs
      border
      border-transparent;
    transition: background-color .2s ease, color .2s ease;
  }
  .badge-button {
    @apply
      cursor-pointer
      transition
      duration-300
      hover:brightness-90;
  }
  .badge-info {
    @apply
      bg-slate-400
      dark:bg-slate-500
      text-white
      dark:text-slate-200;
  }
  .badge-info-outlined {
    @apply
      border-slate-400/30
      dark:border-slate-500/30
      bg-slate-400/5
      dark:bg-slate-500/5
      text-slate-400
      dark:text-slate-500;
  }
  .badge-success {
    @apply
      bg-primary-500
      text-primary-contrast;
  }
  .badge-success-outlined {
    @apply
      border-primary-500/30
      bg-primary-500/5
      text-primary-500;
  }
  .badge-warning {
    @apply
      bg-yellow-600
      text-white
      dark:text-slate-200;
  }
  .badge-warning-outlined {
    @apply
      border-yellow-600/30
      bg-yellow-600/5
      text-yellow-600;
  }
  .badge-error {
    @apply
      bg-red-400
      dark:bg-red-500
      text-white
      dark:text-slate-200;
  }
  .badge-error-outlined {
    @apply
      border-red-400/30
      dark:border-red-500/30
      bg-red-400/5
      dark:bg-red-500/10
      text-red-400
      dark:text-red-500;
  }
  .badge-raw,
  .badge-raw-outlined {
    @apply
      bg-slate-200
      dark:bg-slate-700
      text-slate-600
      dark:text-slate-300;
  }
</style>
