/** Viewport coordinates for the application's arrowless confirmation overlay. */
export function confirm_popup_position(
  target: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  popup: Pick<DOMRect, 'width' | 'height'>,
  viewport: { width: number, height: number },
  gap: number,
  rtl: boolean,
) {
  const below = target.bottom + gap
  const above = target.top - popup.height - gap
  const top = below + popup.height > viewport.height && above >= 0 ? above : below
  const left = rtl ? target.right - popup.width : target.left
  return {
    left: Math.max(0, Math.min(left, viewport.width - popup.width)),
    top: Math.max(0, Math.min(top, viewport.height - popup.height)),
  }
}
