<template>
  <component :is="tag" class="inline-flex items-center gap-[.2em]">
    <template v-for="(char, index) in chars" :key="`${char}-${index}`">
      <span>{{ char }}</span>
    </template>
  </component>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  tag?: keyof HTMLElementTagNameMap
  text: string
}>(), {
  tag: 'span',
})

const chars = computed(() => props.text.split(''))
</script>
