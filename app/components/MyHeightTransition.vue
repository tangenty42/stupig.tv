<template>
  <div
    ref="containerRef"
    class="my-height-transition"
  >
    <div ref="innerRef" class="my-height-transition-inner">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  active?: boolean
  duration?: number
  easing?: string
  threshold?: number
  keepExplicitHeight?: boolean
}>(), {
  active: true,
  duration: 300,
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
  threshold: 0.5,
  keepExplicitHeight: true,
})

const containerRef = ref<HTMLElement | null>(null)
const innerRef = ref<HTMLElement | null>(null)

let observer: ResizeObserver | null = null
let cleanupTimer: ReturnType<typeof setTimeout> | null = null
let removeTransitionEndListener: (() => void) | null = null
let isAnimating = false
let targetHeight = 0

function stopCleanupTimer() {
  if (! cleanupTimer)
    return

  clearTimeout(cleanupTimer)
  cleanupTimer = null
}

function stopObserver() {
  if (! observer)
    return

  observer.disconnect()
  observer = null
}

function removeTransitionListener() {
  if (! removeTransitionEndListener)
    return

  removeTransitionEndListener()
  removeTransitionEndListener = null
}

function resetContainerStyles(container: HTMLElement) {
  if (props.keepExplicitHeight)
    container.style.height = `${targetHeight}px`
  else
    container.style.height = ''

  container.style.transition = ''
  container.style.willChange = ''
  // No clipping at rest: any overflow value (even overflow-y) turns the
  // container into a scroll container that also clips horizontally, which
  // would crop box-shadow and other horizontal overflow of the content.
  container.style.overflow = ''
}

function ensureTransitionEndCleanup(container: HTMLElement) {
  removeTransitionListener()

  const onTransitionEnd = (event: TransitionEvent) => {
    if (event.propertyName !== 'height')
      return

    const currentHeight = container.getBoundingClientRect().height
    if (Math.abs(currentHeight - targetHeight) > props.threshold)
      return

    isAnimating = false
    resetContainerStyles(container)
    stopCleanupTimer()
    removeTransitionListener()
  }

  container.addEventListener('transitionend', onTransitionEnd)
  removeTransitionEndListener = () => {
    container.removeEventListener('transitionend', onTransitionEnd)
  }
}

function animateToHeight(container: HTMLElement, nextHeight: number) {
  const currentHeight = container.getBoundingClientRect().height
  if (Math.abs(nextHeight - currentHeight) < props.threshold)
    return

  targetHeight = nextHeight
  container.style.overflow = 'hidden'
  container.style.willChange = 'height'

  if (! isAnimating) {
    container.style.transition = ''
    container.style.height = `${currentHeight}px`

    // Force layout so transition starts from current rendered height.
    void container.offsetHeight

    container.style.transition = `height ${props.duration}ms ${props.easing}`
    isAnimating = true
    ensureTransitionEndCleanup(container)
  }

  container.style.height = `${nextHeight}px`

  stopCleanupTimer()
  cleanupTimer = setTimeout(() => {
    isAnimating = false
    resetContainerStyles(container)
    stopCleanupTimer()
    removeTransitionListener()
  }, props.duration + 150)
}

function stopAll() {
  stopObserver()
  stopCleanupTimer()
  removeTransitionListener()
  isAnimating = false

  const container = containerRef.value
  if (container)
    resetContainerStyles(container)
}

function startObserving() {
  const container = containerRef.value
  const inner = innerRef.value
  if (! container || ! inner || ! props.active)
    return

  targetHeight = inner.getBoundingClientRect().height
  container.style.height = `${targetHeight}px`

  stopObserver()

  observer = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (! entry || ! props.active)
      return

    const nextHeight = entry.contentRect.height
    if (Math.abs(nextHeight - targetHeight) < props.threshold)
      return

    targetHeight = nextHeight
    animateToHeight(container, nextHeight)
  })

  observer.observe(inner)
}

onMounted(() => {
  startObserving()
})

watch(() => props.active, async (active) => {
  if (! import.meta.client)
    return

  if (active) {
    await nextTick()
    startObserving()
    return
  }

  stopAll()
})

watch(() => [props.duration, props.easing, props.threshold, props.keepExplicitHeight], () => {
  if (! import.meta.client)
    return

  const container = containerRef.value
  if (container && ! isAnimating)
    resetContainerStyles(container)
})

onBeforeUnmount(() => {
  stopAll()
})
</script>

<style scoped>
  .my-height-transition {
    width: 100%;
    /* No overflow at rest: overflow is applied inline only during the height
       animation (see animateToHeight) and removed afterwards, so box-shadow
       and other overflow of the content are never cropped. */
  }

  .my-height-transition-inner {
    width: 100%;
    /* Establish a flow-root formatting context so child vertical margins
       (my-4, last-card mb-4, ...) do not collapse out of the measured box.
       Without this, a child's margin-top escapes the ResizeObserver-measured
       height and renders as no visible gap. */
    display: flow-root;
  }
</style>
