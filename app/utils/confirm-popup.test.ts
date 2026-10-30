import { expect, it } from 'vitest'
import { confirm_popup_position } from './confirm-popup'

const viewport = { width: 1000, height: 600 }
const popup = { width: 200, height: 100 }

it('anchors below the trigger with the theme gutter', () => {
  expect(confirm_popup_position({ left: 100, right: 180, top: 50, bottom: 80 }, popup, viewport, 2, false))
    .toEqual({ left: 100, top: 82 })
})

it('flips upward near the bottom and fits the right viewport edge', () => {
  expect(confirm_popup_position({ left: 950, right: 990, top: 540, bottom: 580 }, popup, viewport, 2, false))
    .toEqual({ left: 800, top: 438 })
})

it('aligns to the right edge for RTL content', () => {
  expect(confirm_popup_position({ left: 300, right: 380, top: 50, bottom: 80 }, popup, viewport, 2, true))
    .toEqual({ left: 180, top: 82 })
})

it('clamps an oversized overlay without generating negative coordinates', () => {
  expect(confirm_popup_position({ left: 100, right: 180, top: 50, bottom: 80 }, { width: 1200, height: 900 }, viewport, 2, false))
    .toEqual({ left: 0, top: 0 })
})
