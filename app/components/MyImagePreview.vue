<template>
  <div ref="viewer_container" style="display: none;">
    <MyIcon name="lucide:loader-circle" />
    <MyIcon name="lucide:image-off" />
    <img v-for="(src, index) in images" :key="index" :data-src="src" :alt="alt_for(index)">
  </div>
</template>

<script setup lang="ts">
import Viewer from 'viewerjs'
import { image_loading_mask, image_unavailable } from '~/features/content/image-frame'
import { image_load_state } from '~/features/content/image-placeholders'

const props = withDefaults(defineProps<{
  images: string[]
  initialIndex?: number
}>(), {
  initialIndex: 0,
})

const visible = defineModel<boolean>('visible', { default: false })

const viewer_container = ref<HTMLElement | null>(null)
let viewer: Viewer | null = null
// Image-set signature the current viewer instance was built with; used to
// rebuild on open when the set changed in the same tick as `visible`.
let built_joined = ''
// True while a viewerjs show/hide callback is writing back to the model, so
// the model watcher doesn't echo the same transition back into the viewer
// (which would race the open/close transition and tear the overlay).
let syncing_from_viewer = false
let hiding = false
let image_view: { ready: (image: HTMLImageElement) => void, stop: () => void } | undefined

function alt_for(index: number) {
  return `图片 ${index + 1}`
}

const { error } = useMyToast()

function clear_image_view() {
  image_view?.stop()
  image_view = undefined
}

function track_image_view(image: HTMLImageElement) {
  clear_image_view()
  image.classList.add('viewer-image-state', 'viewer-image-pending')
  let active = true
  let loading_mask: HTMLElement | null = null
  let failure_notice: HTMLElement | null = null
  let src = image.src

  function current_canvas() {
    const canvas = image.parentElement
    return active && canvas?.classList.contains('viewer-canvas') && canvas.firstElementChild === image ? canvas : null
  }

  function settle(state: 'loaded' | 'error') {
    const canvas = current_canvas()
    if (! canvas)
      return
    active = false
    image.removeEventListener('error', failed)
    if (state === 'error')
      canvas.classList.remove('viewer-loading')
    canvas.dataset.imageState = state
    canvas.removeAttribute('aria-busy')
    loading_mask?.setAttribute('aria-hidden', 'true')
    failure_notice?.setAttribute('aria-hidden', String(state !== 'error'))
    image.classList.remove('viewer-image-pending')
  }

  function failed() {
    if (! current_canvas())
      return
    // Viewer may start its fallback on this same element before our listener.
    if (image.src !== src) {
      src = image.src
      return
    }
    settle('error')
  }

  // Viewer dispatches view synchronously before attaching the image and its own
  // listeners. Native image events are queued, so wire ours after that setup.
  queueMicrotask(() => {
    const canvas = current_canvas()
    if (! canvas)
      return
    const state = image_load_state(image)
    if (state === 'loaded')
      return
    delete canvas.dataset.imageState
    canvas.setAttribute('aria-busy', 'true')
    image.addEventListener('error', failed)
    canvas.insertAdjacentHTML('beforeend', image_loading_mask('图片加载中'))
    loading_mask = canvas.lastElementChild as HTMLElement
    loading_mask.setAttribute('aria-hidden', 'false')
    const label = '图片加载失败'
    failure_notice = document.createElement('span')
    failure_notice.className = 'viewer-image-unavailable'
    failure_notice.setAttribute('role', 'status')
    failure_notice.setAttribute('aria-hidden', 'true')
    failure_notice.innerHTML = `<span aria-hidden="true">${image_unavailable(label)}</span><span class="sr-only">${label}</span>`
    canvas.append(failure_notice)
    if (state === 'error') {
      failed()
      return
    }
    // Both layers start transparent, including a newly opened pending request.
    // Keep them mounted through settlement so they can crossfade together.
    void canvas.offsetWidth
    canvas.dataset.imageState = 'loading'
  })

  image_view = {
    ready(viewed_image) {
      if (viewed_image !== image || ! current_canvas())
        return
      const fitted_src = image.src
      const reveal = () => {
        if (image.src !== fitted_src)
          return
        const state = image_load_state(image)
        if (state !== 'loading')
          settle(state)
      }
      if (typeof image.decode === 'function')
        void image.decode().then(reveal, reveal)
      else
        reveal()
    },
    stop() {
      active = false
      image.removeEventListener('error', failed)
      loading_mask?.remove()
      failure_notice?.remove()
      image.parentElement?.removeAttribute('aria-busy')
    },
  }
}

function create_viewer() {
  if (! viewer_container.value) {
    error('图片预览模块爆了！')
    return
  }
  clear_image_view()
  if (viewer) {
    viewer.destroy()
    viewer = null
  }
  hiding = false
  built_joined = props.images.join('\n')

  viewer = new Viewer(viewer_container.value, {
    inline: false,
    loading: true,
    url: 'data-src',
    view({ detail: { image } }) {
      track_image_view(image)
    },
    viewed({ detail: { image } }) {
      image_view?.ready(image)
    },
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
    // Fit before revealing the image. Viewer waits for transitionend if enabled.
    transition: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { view: false },
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
      hiding = true
      clear_image_view()
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      syncing_from_viewer = true
      visible.value = false
      nextTick(() => {
        syncing_from_viewer = false
      })
    },
    hidden() {
      hiding = false
      if (visible.value)
        nextTick(open_viewer)
    },
  })
}

function open_viewer() {
  if (! visible.value || ! viewer || hiding)
    return
  // A newly assigned image set reaches the hidden source elements in this
  // render tick. Rebuild before asking Viewer to open the selected image.
  if (props.images.join('\n') !== built_joined)
    create_viewer()
  viewer?.view(props.initialIndex)
}

onMounted(() => {
  create_viewer()
  open_viewer()
})

// Recreate the viewer only when the image set actually changes. The parent
// recomputes `render_result` (a fresh array) on many unrelated reactive
// updates, and rebuilding mid-view tears the open overlay — so compare URLs
// and skip while the viewer is open.
watch(() => props.images.join('\n'), (joined, previous) => {
  if (joined === previous || visible.value) {
    return
  }
  nextTick(() => {
    if (! visible.value && joined !== built_joined)
      create_viewer()
  })
})

// The parent's v-model is the single source of truth for "should be open".
// Opening goes through view(index) so a single long-lived viewer instance is
// reused (no remount per image) and lands directly on the tapped image.
watch(visible, (is_visible) => {
  if (syncing_from_viewer) {
    return
  }
  nextTick(() => {
    if (visible.value !== is_visible)
      return
    if (is_visible)
      open_viewer()
    else
      viewer?.hide()
  })
})

onUnmounted(() => {
  clear_image_view()
  viewer?.destroy()
  viewer = null
})
</script>

<style>
/* Viewer mounts under body. Keep only the shared loading icon on the canvas. */
.viewer-canvas.viewer-loading::after {
  content: none;
}

.viewer-canvas > img.viewer-image-state {
  opacity: 0;
}

@media (prefers-reduced-motion: no-preference) {
  .viewer-canvas[data-image-state='loaded'],
  .viewer-canvas[data-image-state='error'] {
    --image-state-duration: 600ms;
    --image-state-easing: ease-in-out;
  }
}

.viewer-canvas[data-image-state='loaded'] > img.viewer-image-state:not(.viewer-image-pending),
.viewer-canvas[data-image-state='error'] > .viewer-image-unavailable {
  opacity: 1;
  /* An opacity transition would also finish Viewer's geometry/close callbacks. */
  animation: viewer-image-appear var(--image-state-duration, 450ms) var(--image-state-easing, ease) both;
}

@keyframes viewer-image-appear {
  from { opacity: 0; }
  to { opacity: 1; }
}

.viewer-canvas > .image-loading-mask {
  opacity: 0;
  visibility: hidden;
  transition: opacity var(--image-state-duration, 450ms) var(--image-state-easing, ease), visibility 0s linear var(--image-state-duration, 450ms);
}

.viewer-canvas[data-image-state='loading'] > .image-loading-mask {
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
}

.viewer-canvas > .viewer-image-unavailable {
  @apply pointer-events-none absolute inset-0 flex items-center justify-center;
  background-color: var(--content-card-surface);
  visibility: hidden;
}

.viewer-canvas[data-image-state='error'] > .viewer-image-unavailable {
  visibility: visible;
}
</style>
