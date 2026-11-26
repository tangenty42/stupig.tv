<template>
  <section :aria-labelledby="id" class="min-w-0">
    <h2 :id="id" ref="heading" tabindex="-1" class="mb-4 [scroll-margin-top:calc(var(--app-header-height,0px)+1rem)]">
      {{ title }}
    </h2>
    <Card class="min-w-0 rounded-sm border border-slate-200 bg-white/80 shadow-sm dark:border-slate-700 dark:bg-slate-900/50">
      <template #content>
        <MyHeightTransition>
          <slot />
        </MyHeightTransition>
      </template>
    </Card>
    <slot name="after" />
  </section>
</template>

<script setup lang="ts">
defineProps<{ title: string }>()

const id = useId()
const heading = useTemplateRef<HTMLHeadingElement>('heading')

function focusHeading() {
  heading.value?.focus({ preventScroll: true })
  heading.value?.scrollIntoView({ block: 'start' })
}

defineExpose({ focusHeading })
</script>
