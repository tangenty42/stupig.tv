import { describe, expect, it } from 'vitest'
import { default_editor_view_state, parse_editor_view_state } from './view-state'

describe('editor presentation state', () => {
  it('rejects unrelated versions and picks only presentation fields', () => {
    expect(parse_editor_view_state(null)).toBeNull()
    expect(parse_editor_view_state({ version: 2 })).toBeNull()
    const state = parse_editor_view_state({ ... default_editor_view_state(), fullscreen: true, markdown: 'private text', token: 'private token' })
    expect(state?.fullscreen).toBe(true)
    expect(JSON.stringify(state)).not.toMatch(/private text|private token|markdown|token/)
  })

  it('bounds malformed saved dimensions and cursor/scroll positions', () => {
    const state = parse_editor_view_state({ version: 1, mode: 'wrong', audience: 'wrong', split_ratio: 10, attachments_width: - 50,
      position: { anchor: 12.5, head: - 4, editor: { top: Infinity, left: - 3 }, page: { top: 650, left: 0 } } })!
    expect(state).toMatchObject({ mode: 'edit', audience: 'private', split_ratio: 0.8, attachments_width: 160,
      position: { anchor: 12, head: 0, editor: { top: 0, left: 0 }, preview: { top: 0, left: 0 }, page: { top: 650, left: 0 } } })
    expect(parse_editor_view_state({ version: 1 })?.split_ratio).toBe(0.5)
  })
})
