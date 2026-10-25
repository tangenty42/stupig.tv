import type { Node } from './plan'
import { expect, it } from 'vitest'
import { canonical, node_mime, plan_scope, require_reference_identity, rewrite_markdown } from './plan'

function row(id: number, file_name: string, patch: Partial<Node> = {}): Node {
  return { id, file_name, story_id: 1, is_folder: 0, is_private: 0, parent_id: null, name: '', name_key: null, storage_provider: 'legacy', storage_bucket: 'public', object_key: `source/${id}`, encryption_key: null,
    version: 'old', file_size: 3, mime_type: 'image/png', oss_version_id: null, node_revision: 1, original_key: null, avif_key: null, jpeg_key: null, parent_avif_key: null, image_revision: 0, image_metadata: null, lqip_jpeg: null,
    redacted_avif_key: null, redacted_jpeg_key: null, redacted_metadata: null, redacted_lqip_jpeg: null, redacted_revision: 0, is_edited: 0, ... patch }
}

it('preserves identities, materializes missing ancestors, and inherits nested private folders without corrupting paths', () => {
  const plan = plan_scope([row(1, 'a', { is_folder: 1, is_private: 1 }), row(2, 'a/b', { is_folder: 1, is_private: 1 }), row(3, 'a/b/c/猫.PNG'), row(4, 'x.JPG', { encryption_key: 'key' })])
  expect(plan.issues).toEqual([])
  expect(plan.paths).toEqual({ 'a': 'a.good', 'a/b': 'a.good/b.good', 'a/b/c/猫.PNG': 'a.good/b.good/c/猫.png', 'x.JPG': 'x.jpg.good' })
  expect(plan.nodes.map(node => [node.id, node.path, node.private])).toEqual([[null, '', false], [1, 'a.good', true], [4, 'x.jpg.good', true], [2, 'a.good/b.good', true], [null, 'a.good/b.good/c', true], [3, 'a.good/b.good/c/猫.png', true]])
})

it('rejects NFC/case collisions and a file used as a directory instead of renaming away references', () => {
  expect(plan_scope([row(1, 'é.png'), row(2, 'e\u0301.PNG')]).issues.map(item => item.code)).toContain('duplicate_path')
  expect(plan_scope([row(1, 'a.png'), row(2, 'A.png')]).issues.map(item => item.code)).toContain('name_collision')
  expect(plan_scope([row(1, 'a'), row(2, 'a/b.png')]).issues.map(item => item.code)).toContain('file_as_parent')
})

it('keeps the public twin independent while planning a secret attachment redaction', () => {
  const plan = plan_scope([row(1, 'secret.png.good', { is_private: 1 }), row(2, 'secret.png')])
  expect(plan.twins).toEqual({ 1: 2 })
  expect(plan.nodes.filter(node => node.id !== null).map(node => node.id)).toEqual([2, 1])
  expect(node_mime(row(1, 'source.PNG.good', { mime_type: 'application/octet-stream' }))).toBe('image/png')
})

it('never turns an inherited-private sibling into a public redaction, or reencodes raw GIF/SVG twins', () => {
  const inherited = plan_scope([row(1, 'vault', { is_folder: 1, is_private: 1 }), row(2, 'vault/a.png.good'), row(3, 'vault/a.png')])
  expect(inherited.twins).toEqual({})
  const raw = plan_scope([row(1, 'a.gif.good', { mime_type: 'image/gif' }), row(2, 'a.gif', { mime_type: 'image/gif' })])
  expect(raw.twins).toEqual({})
  expect(plan_scope([row(1, 'a.PNG.GOOD'), row(2, 'a.png')]).twins).toEqual({ 1: 2 })
})

it('rewrites normal and frontmatter references with the same mapper and preserves code/raw HTML', () => {
  // <div> supports Markdown in this dialect; <pre> deliberately does not.
  const input = '---\ncover: a.JPG\n---\n\n![图](att://a.JPG)\n\n`[x](a.JPG)`\n\n<pre>[x](a.JPG)</pre>'
  const output = rewrite_markdown(input, { 'a.JPG': 'a.jpg.good' })
  expect(output).toContain('cover: att://a.jpg.good')
  expect(output).toContain('![图](att://a.jpg.good)')
  expect(output).toContain('`[x](a.JPG)`')
  expect(output).toContain('<pre>[x](a.JPG)</pre>')
})

it('does not need object transfer for a current complete image or a raw GIF', () => {
  const root = row(1, '', { is_folder: 1, storage_provider: 'aliyun', parent_id: 0, name_key: '' })
  const image = row(2, 'a.png', { storage_provider: 'aliyun', parent_id: 1, name: 'a.png', name_key: 'a.png', original_key: 'original', avif_key: 'avif', jpeg_key: 'jpeg' })
  const gif = row(3, 'b.gif', { storage_provider: 'aliyun', parent_id: 1, name: 'b.gif', name_key: 'b.gif', mime_type: 'image/gif' })
  expect(plan_scope([root, image, gif]).changed).toBe(false)
  expect(plan_scope([root, image, gif]).needs_objects).toEqual([])
})

it('canonicalizes MySQL JSON ordering, dates, and binary snapshot data', () => {
  const value = { b: Buffer.from([1, 2]), a: new Date('2026-10-24T00:00:00Z') }
  expect(canonical(value)).toBe(canonical(JSON.parse(JSON.stringify(value))))
  expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }))
})

it('preserves resolved reference identity and tolerates preexisting unresolved references', () => {
  const before = '![image](att://old.PNG)\n\n[](att://missing)'
  const after = '![image](att://old.png)\n\n[](att://missing)'
  expect(() => require_reference_identity(before, after, [row(1, 'old.PNG')], [row(1, 'old.png')])).not.toThrow()
  expect(() => require_reference_identity(before, after, [row(1, 'old.PNG')], [row(2, 'old.png')])).toThrow('reference_identity_changed')
})
