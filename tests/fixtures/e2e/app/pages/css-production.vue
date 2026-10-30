<template>
  <section>
    <p data-testid="css-hydration" class="production-marker">
      {{ mounted ? 'client' : 'server' }}
    </p>
    <Button label="首次打开懒加载弹窗" @click="open_dialog" />
    <LazyCssProductionDialog v-if="dialog_loaded" :visible="dialog_open" @close="dialog_open = false" />
    <Button label="打开确认浮层" @click="open_confirm" />
    <ConfirmPopup group="css-production" :pt="{ transition: confirm_popup_transition }" />
    <p data-testid="css-confirm-result">
      {{ confirmed ? 'confirmed' : 'pending' }}
    </p>
    <Paginator v-model:first="first" :rows="5" :total-records="25" />
    <MyContentMarkdownPreview :markdown="markdown" />
  </section>
</template>

<script setup lang="ts">
const mounted = ref(false)
const dialog_open = ref(false)
const dialog_loaded = ref(false)
const confirmed = ref(false)
const first = ref(0)
const { confirm_require } = useMyConfirm()
const markdown = Array.from({ length: 6 }, (_, index) => `${'#'.repeat(index + 1)} Production heading ${index + 1}\n\n${'Production paragraph.\n\n'.repeat(8)}`).join('\n\n')

onMounted(() => mounted.value = true)

function open_dialog() {
  dialog_loaded.value = true
  dialog_open.value = true
}

function open_confirm(event: Event) {
  confirm_require(event, '只验证浮层，不修改数据', () => confirmed.value = true, { group: 'css-production' })
}
</script>

<style scoped>
.production-marker {
  border-top: 1px solid rgb(7 8 9);
}
</style>
