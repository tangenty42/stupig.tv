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
// True while a viewerjs show/hide callback is writing back to the model, so
// the model watcher doesn't echo the same transition back into the viewer
// (which would race the open/close transition and tear the overlay).
let syncing_from_viewer = false

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
    // Keep the overlay above every app layer (header z-50, PrimeVue
    // Toast/popups) so page content can't bleed through or receive taps.
    zIndex: 21000,
    zIndexInline: 0,
    show() {
      syncing_from_viewer = true
      visible.value = true
      nextTick(() => {
        syncing_from_viewer = false
      })
    },
    hide() {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      syncing_from_viewer = true
      visible.value = false
      nextTick(() => {
        syncing_from_viewer = false
      })
    },
  })
}

onMounted(() => {
  create_viewer()
})

// Recreate the viewer only when the image set actually changes. The parent
// recomputes `render_result` (a fresh array) on many unrelated reactive
// updates, and rebuilding mid-view tears the open overlay — so compare URLs
// and skip while the viewer is open.
watch(() => props.images.join(''), (joined, previous) => {
  if (joined === previous || visible.value) {
    return
  }
  nextTick(() => create_viewer())
})

// The parent's v-model is the single source of truth for "should be open".
// Opening goes through view(index) so a single long-lived viewer instance is
// reused (no remount per image) and lands directly on the tapped image.
watch(visible, (is_visible) => {
  if (syncing_from_viewer) {
    return
  }
  nextTick(() => {
    if (! viewer) {
      return
    }
    if (is_visible) {
      viewer.view(props.initialIndex)
    }
    else {
      viewer.hide()
    }
  })
})

onUnmounted(() => {
  viewer?.destroy()
  viewer = null
})
</script>
