<template>
  <UInput v-bind="$attrs" :type="show ? 'text' : 'password'">
    <template #trailing>
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        :icon="show ? 'i-lucide-eye' : 'i-lucide-eye-off'"
        :aria-label="show ? 'Hide password' : 'Show password'"
        :aria-pressed="show"
        aria-controls="password"
        @click="show = ! show" />
    </template>
  </UInput>
</template>

<script setup lang="ts">
  const show = ref(false)
</script>
