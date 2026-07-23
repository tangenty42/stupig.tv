<template>
  <Button
    :disabled="!!remaining || loading"
    :loading="loading"
    :label="remaining ? duration_format(duration) : '发送'"
    severity="secondary"
    size="small"
    @click="$emit('click', $event)"
  >
    <template #icon>
      <MyIcon name="lucide:send" />
    </template>
  </Button>
</template>

<script setup lang="ts">
import type { Dayjs } from 'dayjs'

defineProps<{
  loading?: boolean
}>()

defineEmits<{
  click: [event: MouseEvent]
}>()

// UTC ISO string (or null). A string is used instead of Dayjs so the value
// survives Nuxt payload serialization between SSR and hydration intact;
// it is localized here at the point of use.
const cooldown_until = defineModel<string | null>({ default: null })
const now = useReactiveDateNow()

const cooldown_until_date = computed(() =>
  cooldown_until.value ? localize_date(cooldown_until.value) : null,
)

const remaining = computed(() => {
  if (! cooldown_until_date.value) {
    return null
  }

  const diff = cooldown_until_date.value.diff(now.value)
  return diff > 0 ? diff : null
})
const duration = computed((): [Dayjs, Dayjs] =>
  [now.value, cooldown_until_date.value ?? now.value],
)
</script>
