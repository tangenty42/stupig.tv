import { describe, expect, it } from 'vitest'
import { draft_title } from './draft-summary'

describe('draft card title', () => {
  it('finds a title in incomplete front matter without exposing the body', () => {
    expect(draft_title('---\ntitle: 草稿标题', true)).toBe('草稿标题')
    expect(draft_title('---\ntitle: 草稿标题\n<good>secret', true)).toBe('草稿标题')
    expect(draft_title('---\n---\ntitle: body', true)).toBe('未命名草稿')
    expect(draft_title('no front matter\ntitle: secret', true)).toBe('未命名草稿')
  })
  it('ignores a line truncated by the bounded read and limits long titles', () => {
    expect(draft_title('---\ntitle: partial', false)).toBe('未命名草稿')
    expect(draft_title(`---\ntitle: ${'x'.repeat(200)}\n`, false)).toHaveLength(120)
    expect(draft_title('---\ntitle:  \n', true)).toBe('未命名草稿')
  })
})
