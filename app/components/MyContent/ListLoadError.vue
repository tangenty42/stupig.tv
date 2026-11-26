<template>
  <div class="text-center" role="alert">
    <Button type="button" label="重新加载" severity="secondary" outlined size="large" @click="$emit('retry')">
      <template #icon>
        <MyIcon name="lucide:rotate-cw" />
      </template>
    </Button>
  </div>
</template>

<script setup lang="ts">
defineEmits<{ retry: [] }>()
</script>
