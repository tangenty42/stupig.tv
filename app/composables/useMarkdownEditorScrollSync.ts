import type { EditorView } from '@codemirror/view'

// VSCode-style scroll sync between the CodeMirror editor and the markdown
// preview pane: preview blocks carry data-line anchors (their body line), and
// both directions interpolate between the anchors bracketing the scroll
// position instead of mapping raw scroll ratios. The mapping is direct
// (preview scrollTop ↔ editor line, anchors measured in flow coordinates), so
// sticky headings play their natural pin/push animation in both directions;
// they only ever overlay content and never change the flow geometry the
// anchors measure. Scroll-loop feedback is prevented by echo detection and
// the driver-intent lock below, not by quantizing the mapping.
// attach/detach are driven by the editor's fullscreen watcher;
// `get_line_offset` supplies the front matter line count of the current
// document.
export function useMarkdownEditorScrollSync(
  get_view: () => EditorView | null,
  preview_pane: Ref<HTMLElement | undefined>,
  get_line_offset: () => number,
) {
  interface ScrollAnchor {
    /** Editor-document line (0-based, front matter offset applied). */
    line: number
    /** Document-space y inside the preview pane. */
    y: number
  }

  function collect_scroll_anchors(): ScrollAnchor[] {
    const pane = preview_pane.value
    if (! pane) {
      return []
    }
    sync_overscroll_padding()
    const line_offset = get_line_offset()
    const pane_top = pane.getBoundingClientRect().top
    const scroll_top = pane.scrollTop
    // Virtual start anchor: the front matter renders nothing in the preview,
    // so without a (line 0, y 0) anchor both directions clamp at the first body
    // element — the editor's front matter scroll sticks the preview, and the
    // preview's scroll-to-top maps to the first body line instead of line 0.
    const anchors: ScrollAnchor[] = [{ line: 0, y: 0 }]
    // A pinned sticky heading reports its pinned position, which tracks the
    // scroll offset itself and corrupts the anchor order — suspend stickiness
    // while measuring. The synchronous block never paints the static state.
    const body = pane.querySelector('.story-body')
    body?.classList.add('measuring')
    try {
      for (const element of pane.querySelectorAll<HTMLElement>('[data-line]')) {
        const line = Number(element.dataset.line)
        if (! Number.isFinite(line)) {
          continue
        }
        anchors.push({ line: line + line_offset, y: element.getBoundingClientRect().top - pane_top + scroll_top })
      }
    }
    finally {
      body?.classList.remove('measuring')
    }
    // Synthetic document-end anchor: the last real anchor usually sits above
    // both panes' max scroll positions (editor scrollPastEnd, preview
    // overscroll), so the tail would clamp and stick. Pairing the two max
    // positions lets the tail interpolate smoothly to the bottom.
    const view = get_view()
    if (view) {
      const scroller = view.scrollDOM
      const editor_max = scroller.scrollHeight - scroller.clientHeight
      const preview_max = pane.scrollHeight - pane.clientHeight
      if (editor_max > 1 && preview_max > 1) {
        const block = view.lineBlockAtHeight(editor_max)
        const end_line = view.state.doc.lineAt(block.from).number - 1
          + (block.height > 0 ? Math.min(Math.max((editor_max - block.top) / block.height, 0), 1) : 0)
        anchors.push({ line: end_line, y: preview_max })
      }
    }
    anchors.sort((a, b) => a.line - b.line || a.y - b.y)
    return anchors
  }

  /** Map one anchor axis to the other, interpolating between bracketing anchors. */
  function interpolate_anchors(anchors: ScrollAnchor[], key: 'line' | 'y', value: number) {
    const other = key === 'line' ? 'y' : 'line'
    const first = anchors[0]!
    const last = anchors[anchors.length - 1]!
    if (value <= first[key]) {
      return first[other]
    }
    if (value >= last[key]) {
      return last[other]
    }
    for (let i = 1; i < anchors.length; i ++) {
      const next = anchors[i]!
      if (next[key] >= value) {
        const prev = anchors[i - 1]!
        const span = next[key] - prev[key]
        if (span <= 0) {
          return prev[other]
        }
        return prev[other] + ((value - prev[key]) / span) * (next[other] - prev[other])
      }
    }
    return last[other]
  }

  // VSCode-style overscroll: the editor's scrollPastEnd() pads its content by
  // editorHeight - lineHeight (measured live) so the last line can scroll to
  // the pane top. Mirror it here with an inline padding, refreshed on
  // attach/resize and on every anchor collection (content edits change the
  // trailing block). The padding is a full viewport regardless of the
  // trailing block's height: a tall trailing block (e.g. a carousel) still
  // gets its whole height mapped into the scroll range — zero padding would
  // compress the editor's last (possibly giant, wrapped) line into a few
  // preview pixels and feel stuck. The space below the trailing block (its
  // bottom margin, section margins) is measured rather than guessed.
  function sync_overscroll_padding() {
    const pane = preview_pane.value
    const body = pane?.querySelector<HTMLElement>('.story-body')
    if (! pane || ! body) {
      return
    }
    let last: Element | null = body.lastElementChild
    while (last?.classList.contains('story-section') && last.lastElementChild) {
      last = last.lastElementChild
    }
    if (! last) {
      return
    }
    const body_style = getComputedStyle(body)
    const content_end = body.getBoundingClientRect().bottom
      - (Number.parseFloat(body_style.paddingBottom) || 0)
      - (Number.parseFloat(body_style.borderBottomWidth) || 0)
    const last_rect = last.getBoundingClientRect()
    const pane_padding = Number.parseFloat(getComputedStyle(pane).paddingBottom) || 0
    const padding = `${Math.max(0, pane.clientHeight - pane_padding - (content_end - last_rect.bottom))}px`
    if (body.style.paddingBottom !== padding) {
      body.style.paddingBottom = padding
    }
  }

  /** Fractional 0-based line at the top of the editor viewport. */
  function editor_top_line() {
    const view = get_view()
    if (! view) {
      return null
    }
    // Document-space math only: posAtCoords/coordsAtPos mix in CodeMirror's
    // cached scroll position, which lags behind programmatic scrollTop writes
    // (CM re-measures on rAF) and breaks the mapping while syncing.
    const doc_height = view.scrollDOM.getBoundingClientRect().top - view.documentTop
    const block = view.lineBlockAtHeight(doc_height)
    const line = view.state.doc.lineAt(block.from).number - 1
    const ratio = block.height > 0
      ? Math.min(Math.max((doc_height - block.top) / block.height, 0), 1)
      : 0
    return line + ratio
  }

  /** Convert a document-space content-y to the preview scroll position. */
  function scroll_pane_to_content_y(pane: HTMLElement, y: number) {
    // Anchors are flow coordinates, so y IS the scroll position: sticky
    // headings overlay content without moving it. The dock/push animation
    // plays naturally as this crosses heading boundaries.
    const target = Math.max(0, y)
    if (Math.abs(pane.scrollTop - target) >= 1) {
      pane.scrollTop = target
    }
  }

  /** Scroll the editor so the fractional 0-based line sits at the viewport top. */
  function scroll_editor_to_line(fractional_line: number) {
    const view = get_view()
    if (! view) {
      return
    }
    const doc = view.state.doc
    const line_index = Math.min(Math.max(Math.floor(fractional_line), 0), doc.lines - 1)
    const block = view.lineBlockAt(doc.line(line_index + 1).from)
    const scroller = view.scrollDOM
    const target = scroller.scrollTop
      + (view.documentTop + block.top - scroller.getBoundingClientRect().top)
      + (fractional_line - line_index) * block.height
    // Skip sub-pixel writes: each write fires an echo event, so rewriting the
    // same position every frame is pure churn.
    if (Math.abs(scroller.scrollTop - target) < 1) {
      return
    }
    scroller.scrollTop = target
  }

  // Echo detection breaks the scroll-event feedback loop without rAF timing
  // races: a scroll event landing (within rounding) on the target we just set
  // programmatically is our own echo, not user input.
  let expected_editor_scroll: number | null = null
  let expected_preview_scroll: number | null = null

  // User-intent lock: wheel/touch/pointer activity on a pane marks it as the
  // driver for a short window; while one pane holds intent, scroll events
  // from the OTHER pane are ignored. Wheel/touch only ever come from the
  // user, so this cleanly filters CodeMirror's scroll self-corrections (line
  // heights resolve as newly revealed lines are measured) without the
  // alternation desync of a scroll-event-based lock: grabbing the other pane
  // flips the driver instantly. Keyboard and scrollbar scrolling still sync
  // whenever the other pane holds no active intent.
  let driver: 'editor' | 'preview' | null = null
  let driver_until = 0
  const DRIVER_WINDOW_MS = 400

  function note_intent(pane: 'editor' | 'preview') {
    driver = pane
    driver_until = performance.now() + DRIVER_WINDOW_MS
  }

  function has_contrary_intent(pane: 'editor' | 'preview') {
    return driver !== null && driver !== pane && performance.now() < driver_until
  }

  function on_editor_scrolled() {
    const view = get_view()
    if (! view || ! preview_pane.value) {
      return
    }
    if (expected_editor_scroll !== null) {
      const echo = Math.abs(view.scrollDOM.scrollTop - expected_editor_scroll) < 2
      expected_editor_scroll = null
      if (echo) {
        return
      }
    }
    if (has_contrary_intent('editor')) {
      return
    }
    const line = editor_top_line()
    const anchors = collect_scroll_anchors()
    if (line === null || ! anchors.length) {
      return
    }
    const pane = preview_pane.value
    const y = interpolate_anchors(anchors, 'line', line)
    const before = pane.scrollTop
    scroll_pane_to_content_y(pane, y)
    // When the assignment clamps (preview already at its max) no scroll event
    // fires, so don't leave a stale expectation that would swallow the next
    // genuine user scroll as an echo.
    expected_preview_scroll = pane.scrollTop === before ? null : pane.scrollTop
  }

  function on_preview_scrolled() {
    const view = get_view()
    if (! view || ! preview_pane.value) {
      return
    }
    if (expected_preview_scroll !== null) {
      const echo = Math.abs(preview_pane.value.scrollTop - expected_preview_scroll) < 2
      expected_preview_scroll = null
      if (echo) {
        return
      }
    }
    if (has_contrary_intent('preview')) {
      return
    }
    const anchors = collect_scroll_anchors()
    if (! anchors.length) {
      return
    }
    const before = view.scrollDOM.scrollTop
    // Direct scrollTop mapping: anchors are flow coordinates on both axes, so
    // this stays continuous through heading dock/push transitions (a pinned
    // heading merely covers the mapped content, it doesn't shift it) — no
    // editor jump when the preview scrolls past a heading.
    scroll_editor_to_line(interpolate_anchors(anchors, 'y', preview_pane.value.scrollTop))
    expected_editor_scroll = view.scrollDOM.scrollTop === before ? null : view.scrollDOM.scrollTop
  }

  const INTENT_EVENTS = ['wheel', 'touchstart', 'pointerdown'] as const
  const on_editor_intent = () => note_intent('editor')
  const on_preview_intent = () => note_intent('preview')

  function attach() {
    const view = get_view()
    const pane = preview_pane.value
    view?.scrollDOM.addEventListener('scroll', on_editor_scrolled, { passive: true })
    pane?.addEventListener('scroll', on_preview_scrolled, { passive: true })
    for (const type of INTENT_EVENTS) {
      view?.scrollDOM.addEventListener(type, on_editor_intent, { passive: true })
      pane?.addEventListener(type, on_preview_intent, { passive: true })
    }
    window.addEventListener('resize', sync_overscroll_padding)
    sync_overscroll_padding()
  }

  function detach() {
    expected_editor_scroll = null
    expected_preview_scroll = null
    driver = null
    window.removeEventListener('resize', sync_overscroll_padding)
    const view = get_view()
    const pane = preview_pane.value
    view?.scrollDOM.removeEventListener('scroll', on_editor_scrolled)
    pane?.removeEventListener('scroll', on_preview_scrolled)
    for (const type of INTENT_EVENTS) {
      view?.scrollDOM.removeEventListener(type, on_editor_intent)
      pane?.removeEventListener(type, on_preview_intent)
    }
    const body = preview_pane.value?.querySelector<HTMLElement>('.story-body')
    if (body) {
      body.style.paddingBottom = ''
    }
  }

  return { attach, detach }
}
