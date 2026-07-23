<template>
  <span class="badge" :class="`badge-${type ?? 'info'}${outlined ? '-outlined' : ''}`"><slot /></span>
</template>

<script lang="ts" setup>
defineProps<{
  type?: 'info' | 'success' | 'warning' | 'error'
  outlined?: true
}>()
</script>

<style scoped>
  .badge :deep(*) {
    color: inherit;
  }
  .badge-info {
    @apply
      rounded-sm
      bg-slate-400
      dark:bg-slate-500
      px-2
      py-1
      text-xs
      leading-tight
      text-white
      dark:text-slate-200;
  }
  .badge-info-outlined {
    @apply
      rounded-sm
      border
      border-slate-400/30
      dark:border-slate-500/30
      bg-slate-400/5
      dark:bg-slate-500/5
      px-2
      py-1
      text-xs
      leading-tight
      text-slate-400
      dark:text-slate-500;
  }
  .badge-success {
    @apply
      rounded-sm
      bg-primary-500
      px-2
      py-1
      text-xs
      leading-tight
      text-primary-contrast;
  }
  .badge-success-outlined {
    @apply
      rounded-sm
      border
      border-primary-500/30
      bg-primary-500/5
      px-2
      py-1
      text-xs
      leading-tight
      text-primary-500;
  }
  .badge-warning {
    @apply
      rounded-sm
      bg-yellow-600
      px-2
      py-1
      text-xs
      leading-tight
      text-white
      dark:text-slate-200;
  }
  .badge-warning-outlined {
    @apply
      rounded-sm
      border
      border-yellow-600/30
      bg-yellow-600/5
      px-2
      py-1
      text-xs
      leading-tight
      text-yellow-600;
  }
  .badge-error {
    @apply
      rounded-sm
      bg-red-400
      dark:bg-red-500
      px-2
      py-1
      text-xs
      leading-tight
      text-white
      dark:text-slate-200;
  }
  .badge-error-outlined {
    @apply
      rounded-sm
      border
      border-red-400/30
      dark:border-red-500/30
      bg-red-400/5
      dark:bg-red-500/10
      px-2
      py-1
      text-xs
      leading-tight
      text-red-400
      dark:text-red-500;
  }
</style>
