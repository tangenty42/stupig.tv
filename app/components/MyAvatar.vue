<template>
  <div
    v-if="image_url && image_state !== 'error'"
    class="avatar-wrapper"
    :class="{ 'avatar-previewable cursor-zoom-in': previewable }"
    :style="{ width: size_computed, height: size_computed }"
    v-bind="$attrs"
    @click="on_click"
  >
    <img
      :key="image_url"
      ref="avatar_image"
      :src="image_url"
      :alt="`${props.user.username} 的头像`"
      :loading="lazy ? 'lazy' : 'eager'"
      class="h-full w-full object-cover"
      :class="{ 'opacity-0': show_skeleton }"
      @load="on_image_settled"
      @error="on_image_settled"
    >
    <div
      v-if="show_skeleton"
      class="absolute inset-0 animate-pulse bg-slate-200 dark:bg-slate-700"
    />

    <div
      v-if="previewable"
      class="avatar-overlay"
      aria-hidden="true"
    >
      <MyIcon name="lucide:eye" class="avatar-overlay-icon" :style="{ fontSize: `calc(${size_computed} / 2.5)` }" />
    </div>
  </div>

  <div
    v-else
    class="avatar-wrapper"
    :style="{ width: size_computed, height: size_computed, fontSize: `calc(${size_computed} / 2.5)` }"
    v-bind="$attrs"
  >
    <div class="avatar-fallback">
      {{ fallback }}
    </div>
  </div>

  <ClientOnly>
    <MyImagePreview v-if="previewable" v-model:visible="preview_visible" :images="preview_images" />
  </ClientOnly>
</template>

<script setup lang="ts">
import { image_load_state } from '~/features/content/image-placeholders'
import { avatar_url } from '~/utils/avatar'

export interface AvatarUser {
  id: number
  username: string
  avatar_file: string | null
  avatar_version?: string | null
}

const props = withDefaults(defineProps<{
  user: AvatarUser
  size?: 'small' | 'medium' | 'large' | 'xlarge'
  previewable?: boolean
  lazy?: boolean
}>(), {
  size: 'small',
  previewable: false,
  lazy: false,
})

const static_url = useStaticUrl()

const image_url = computed(() => avatar_url(static_url, props.user.avatar_file, props.user.avatar_version ?? null))
const avatar_image = useTemplateRef<HTMLImageElement>('avatar_image')
const image_state = ref<ReturnType<typeof image_load_state>>('loading')
const fallback = computed(() => props.user.username.slice(0, 1).toUpperCase())
const preview_visible = ref(false)
const preview_images = computed(() => image_url.value ? [image_url.value] : [])

const show_skeleton = computed(() => props.lazy && image_state.value === 'loading')

const size_computed = computed(() => {
  switch (props.size) {
    case 'small': return '2rem'
    case 'medium': return '3rem'
    case 'large': return '4rem'
    case 'xlarge': return '8rem'
    default: return '2rem'
  }
})

watch(image_url, () => {
  image_state.value = 'loading'
}, { flush: 'sync' })
watch(avatar_image, (image) => {
  if (image && image.getAttribute('src') === image_url.value)
    image_state.value = image_load_state(image)
}, { flush: 'post' })

function on_click() {
  if (props.previewable && image_url.value) {
    preview_visible.value = true
  }
}

function on_image_settled(event: Event) {
  const image = avatar_image.value
  if (image && event.currentTarget === image && image.getAttribute('src') === image_url.value)
    image_state.value = event.type === 'error' ? 'error' : image_load_state(image)
}
</script>

<style scoped>
  .avatar-wrapper {
    @apply shrink-0 relative inline-flex overflow-hidden rounded-full;
  }

  .avatar-previewable {
    @apply transition-all duration-300 ease-in-out;
  }

  .avatar-previewable:hover {
    @apply shadow-lg shadow-slate-900/10;
  }

  .avatar-overlay {
    @apply pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-900/45 opacity-0 transition-opacity duration-200;
  }

  .avatar-previewable:hover .avatar-overlay {
    @apply opacity-100;
  }

  .avatar-overlay-icon {
    @apply text-2xl text-slate-100 drop-shadow;
  }

  .avatar-fallback {
    @apply inline-flex h-full w-full items-center justify-center bg-slate-200 font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-200;
  }
</style>
