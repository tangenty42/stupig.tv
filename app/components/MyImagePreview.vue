<template>
  <div ref="viewer_container" style="display: none;">
    <img v-for="(src, index) in images" :key="src" :src="src" :alt="alt_for(index)">
  </div>
</template>

<script setup lang="ts">
import Viewer from 'viewerjs'

const props = withDefaults(defineProps<{
  images: string[]
  initialIndex?: number
}>(), {
  initialIndex: 0,
})

const visible = defineModel<boolean>('visible', { default: false })

const viewer_container = ref<HTMLElement | null>(null)
let viewer: Viewer | null = null

function alt_for(index: number) {
  return `图片 ${index + 1}`
}

const { error } = useMyToast()

function create_viewer() {
  if (! viewer_container.value) {
    error('图片预览模块爆了！')
    return
  }
  if (viewer) {
    viewer.hide()
    viewer.destroy()
    viewer = null
  }

  viewer = new Viewer(viewer_container.value, {
    inline: false,
    button: true,
    navbar: props.images.length > 1,
    title: false,
    toolbar: {
      zoomIn: true,
      zoomOut: true,
      oneToOne: true,
      reset: true,
      prev: props.images.length > 1,
      play: false,
      next: props.images.length > 1,
      rotateLeft: true,
      rotateRight: true,
      flipHorizontal: true,
      flipVertical: true,
    },
    tooltip: true,
    movable: true,
    zoomable: true,
    rotatable: true,
    scalable: true,
    transition: true,
    fullscreen: true,
    keyboard: true,
    backdrop: true,
    loop: true,
    interval: 0,
    initialViewIndex: props.initialIndex,
    zIndex: 9999,
    zIndexInline: 0,
    ready() {
      visible.value = true
    },
    hide() {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      visible.value = false
    },
  })
}

watch(() => props.images, () => {
  nextTick(() => create_viewer())
}, { deep: true, immediate: true })

watch(visible, (is_visible) => {
  if (is_visible) {
    viewer?.show()
  }
  else {
    viewer?.hide()
  }
})

onUnmounted(() => {
  viewer?.destroy()
  viewer = null
})
</script>
