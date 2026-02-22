<template>
  <UPinInput v-bind="$attrs" class="justify-center" otp :length="6" v-model="val" type="number" />
</template>

<script setup lang="ts">
  const val = ref<number[]>([])
  const model = defineModel<string>()
  
  watch(val, () => {
    let new_val = ''
    for (let i = 0; i < val.value.length; i ++)
      new_val += (val.value[i] === undefined ? '_' : val.value[i])
    model.value = new_val
  })
  watch(model, () => {
    val.value.splice(0)
    if (model.value === undefined)
      return
    val.value.push(
      ... model.value
        .split('')
        .map(v => v === '_' ? undefined as unknown as number : + v)
    )
  }, { immediate: true })
</script>
