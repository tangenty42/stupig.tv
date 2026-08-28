<template>
  <div class="my-divider" role="separator">
    <template v-if="label || $slots.default">
      <span class="line" aria-hidden="true" />
      <span class="label"><slot>{{ label }}</slot></span>
    </template>
    <span class="line" aria-hidden="true" />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  label?: string
}>()
</script>

<style scoped>
  /* The line flanks the label as two segments instead of passing behind it,
     so no background fill is needed and any background image/color shows through.
     Three theming layers, all inherited CSS vars:
       1. global:   --divider-*-light/-dark pairs in global.css (:root)
       2. page:     set the same vars on a page/subtree root to restyle it
       3. instance: set vars on this component (pair vars follow the color
                    scheme automatically; a static --divider-line-color or
                    light-dark() value in --divider-line-color overrides both) */
  /* The negative margins stretch the line segments to the viewport edges
     (the app root clips overflow-x); the label keeps its place because the
     page container is centered, so a viewport-wide divider stays centered. */
  .my-divider {
    @apply -mx-[calc(50vw-50%)] flex items-center;
    gap: var(--divider-gap, .5rem);
  }
  .line {
    @apply h-0 grow;
    border-top: var(--divider-line-width, 1px) var(--divider-line-style, dashed)
      var(--divider-line-color, light-dark(var(--divider-line-color-light), var(--divider-line-color-dark)));
  }
  .label {
    @apply shrink-0 text-xs;
    color: var(--divider-label-color, light-dark(var(--divider-label-color-light), var(--divider-label-color-dark)));
  }
</style>
