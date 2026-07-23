<template>
  <Icon
    :key="name"
    :name="name"
    aria-hidden="true"
    focusable="false"
    v-bind="$attrs"
  />
</template>

<script lang="ts" setup>
defineProps<{
  name: string
}>()
</script>
