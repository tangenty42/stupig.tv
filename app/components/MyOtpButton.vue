<template>
  <UButton v-bind="$attrs" :disabled="!! time && time > 0" icon="lucide:send" size="xs" variant="subtle">
    {{ time && time > 0 ? `${ duration_expand(time) }后可再次发送` : '发送验证码' }}
  </UButton>
</template>

<script setup lang="ts">
  const time = defineModel<number>()

  void (() => {
    if (! globalThis.window)
      return

    watch(time, () => {
      if (! time.value || time.value < 0)
        return

      setTimeout(() => {
        time.value! = Math.max(time.value! - 1000, 0)
      }, 1000)
    }, { immediate: true })
  })()
</script>
