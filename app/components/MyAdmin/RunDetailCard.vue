<template>
  <Card
    role="region" :aria-labelledby="id"
    class="min-w-0 overflow-hidden rounded-sm border border-slate-200 bg-white/80 text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-300"
    :dt="{ body: { padding: '0' } }"
  >
    <template #content>
      <MyHeightTransition>
        <div class="flex items-center gap-3.5 border-b border-slate-200 bg-slate-50 px-3 py-3 dark:border-slate-700 dark:bg-slate-800/60 sm:px-4">
          <MyIcon :name="icon" aria-hidden="true" class="shrink-0 text-2xl text-slate-500 dark:text-slate-400" />
          <div class="min-w-0">
            <h3 :id="id" ref="heading" tabindex="-1" class="text-base font-semibold text-slate-900 [scroll-margin-top:calc(var(--app-header-height,0px)+1rem)] dark:text-slate-100">
              {{ title }}
            </h3>
            <p v-if="subtitle" class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {{ subtitle }}
            </p>
          </div>
        </div>
        <div class="px-3 py-3 empty:hidden sm:px-4">
          <slot />
        </div>
      </MyHeightTransition>
    </template>
  </Card>
</template>

<script setup lang="ts">
defineProps<{ title: string, icon: string, subtitle?: string }>()
const id = useId()
const heading = useTemplateRef<HTMLHeadingElement>('heading')

function focusHeading() {
  heading.value?.focus({ preventScroll: true })
  heading.value?.scrollIntoView({ block: 'start' })
}

defineExpose({ focusHeading })
</script>
