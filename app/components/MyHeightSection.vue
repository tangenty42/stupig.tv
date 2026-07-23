<template>
  <component :is="tag" ref="rootRef">
    <MyHeightTransition>
      <slot />
    </MyHeightTransition>
  </component>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  tag?: keyof HTMLElementTagNameMap
}>(), {
  tag: 'div',
})

const rootRef = ref<HTMLElement | null>(null)

defineExpose({
  el: rootRef,
})
</script>
