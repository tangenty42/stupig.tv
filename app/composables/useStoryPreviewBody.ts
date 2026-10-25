import { setup_carousels } from '~/utils/content/carousel'
import { observe_cropped_images } from '~/utils/content/cropped-images'
import { observe_image_placeholders } from '~/utils/content/lqip'
import { compensate_section_push, layout_heading_offsets, observe_heading_layout, reset_heading_compensation, wrap_heading_sections } from '~/utils/content/sticky-headings'

/** Owns the live preview's DOM update and enhancement lifecycle. */
export function useStoryPreviewBody(body: Readonly<Ref<HTMLElement | null>>, html: () => string, patch?: (body: HTMLElement, html: string) => void) {
  let mounted = false
  let current_body: HTMLElement | null = null
  let current_html: string | undefined
  let cleanups: ((() => void) | null)[] = []

  function release() {
    cleanups.forEach(cleanup => cleanup?.())
    cleanups = []
    current_body = null
  }

  function refresh() {
    if (! mounted || (current_body === body.value && current_html === html()))
      return
    release()
    current_body = body.value
    current_html = html()
    if (! current_body)
      return
    reset_heading_compensation(current_body)
    patch?.(current_body, current_html)
    wrap_heading_sections(current_body)
    compensate_section_push(current_body)
    layout_heading_offsets(current_body)
    cleanups = [
      setup_carousels(current_body),
      observe_image_placeholders(current_body),
      observe_cropped_images(current_body),
      observe_heading_layout(current_body),
    ]
  }

  function on_window_resize() {
    if (current_body)
      layout_heading_offsets(current_body)
  }

  // Post-flush already runs after component props / template refs update. Avoid a
  // second nextTick job that could outlive its body or mount more than once.
  watch([body, html], refresh, { flush: 'post' })
  onMounted(() => {
    mounted = true
    refresh()
    window.addEventListener('resize', on_window_resize)
  })
  onBeforeUnmount(() => {
    mounted = false
    release()
    window.removeEventListener('resize', on_window_resize)
  })
}
