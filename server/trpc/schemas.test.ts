import { api_schema } from '@server/trpc/schemas'
import { describe, expect, it } from 'vitest'

/**
 * The request schemas separate two kinds of argument, and conflating them is
 * what made a folder that had acquired a `.good` name impossible to rename: the
 * name rules ran on the folder's CURRENT path (an identifier the service looks
 * up) instead of only on the new name being chosen.
 *
 * These pin that split. The name rules themselves are covered in
 * `@shared/content-markdown`'s tests; here the question is only which arguments
 * they apply to.
 */
describe('content schemas: new names vs existing identifiers', () => {
  const content = api_schema.content

  function issue_paths(result: { success: boolean, error?: { issues: { path: PropertyKey[] }[] } }) {
    return result.error?.issues.map(issue => issue.path.join('.')) ?? []
  }

  describe('the destination of a folder rename answers to the name rules', () => {
    it('accepts an ordinary new name', () => {
      const result = content.move_folder.safeParse({ id: 13, source_folder: 'cards', new_folder: 'cards2' })
      expect(result.success).toBe(true)
    })

    it('refuses a new name carrying the encryption marker', () => {
      const result = content.move_folder.safeParse({ id: 13, source_folder: 'cards', new_folder: 'cards.good' })
      expect(result.success).toBe(false)
      expect(issue_paths(result)).toContain('new_folder')
    })

    it('refuses a new name with illegal characters', () => {
      const result = content.move_folder.safeParse({ id: 13, source_folder: 'cards', new_folder: 'cards:x' })
      expect(result.success).toBe(false)
      expect(issue_paths(result)).toContain('new_folder')
    })
  })

  describe('the source of a folder rename is looked up, not validated', () => {
    it('accepts a source that already carries the encryption marker', () => {
      // A folder can hold such a name (an upload of a local folder named
      // `*.good` did it before the upload guard existed). Refusing the request
      // for its own source is what left it unrenamable.
      const result = content.move_folder.safeParse({ id: 13, source_folder: 'cards.good', new_folder: 'cards' })
      expect(result.success).toBe(true)
    })

    it('accepts a nested source with a marker on an inner level', () => {
      const result = content.move_folder.safeParse({ id: 13, source_folder: 'a/cards.good', new_folder: 'a/cards' })
      expect(result.success).toBe(true)
    })
  })

  describe('delete_folder addresses an existing folder', () => {
    it('accepts a folder that already carries the encryption marker', () => {
      const result = content.delete_folder.safeParse({ id: 13, folder: 'cards.good' })
      expect(result.success).toBe(true)
    })
  })

  describe('move targets address existing folders', () => {
    it('accepts a target folder that already carries the marker', () => {
      const single = content.move_attachment.safeParse({ id: 13, file_name: 'photo.png', target_folder: 'cards.good' })
      expect(single.success).toBe(true)

      const batch = content.move_attachments.safeParse({
        id: 13,
        moves: [{ file_name: 'photo.png', target_folder: 'cards.good' }],
      })
      expect(batch.success).toBe(true)
    })

    it('still accepts the root target', () => {
      const result = content.move_attachment.safeParse({ id: 13, file_name: 'photo.png', target_folder: null })
      expect(result.success).toBe(true)
    })
  })

  describe('a folder being created is a new name', () => {
    it('accepts an ordinary name', () => {
      expect(content.create_folder.safeParse({ id: 13, folder: 'cards' }).success).toBe(true)
    })

    it('refuses the marker here, which is where such a folder would be born', () => {
      const result = content.create_folder.safeParse({ id: 13, folder: 'cards.good' })
      expect(result.success).toBe(false)
      expect(issue_paths(result)).toContain('folder')
    })
  })
})

/**
 * Upload batches may plan two files onto one path (identical names, or names
 * that sanitize to the same stored name). Both requests preserve the entries;
 * the task service creates distinct items and persists an explicit resolution.
 */
describe('content schemas: duplicate planned upload paths', () => {
  const content = api_schema.content
  const batch = { uploads: [{ path: 'a.png', size: 10, mime_type: null }, { path: 'a.png', size: 10, mime_type: null }] }

  it('preflightTask accepts the dupe', () => {
    expect(content.preflight_task.safeParse({ story_id: 1, kind: 'upload', payload: batch }).success).toBe(true)
  })

  it('createTask preserves it for durable per-entry resolution', () => {
    const result = content.create_task.safeParse({ story_id: 1, kind: 'upload', payload: batch })
    expect(result.success).toBe(true)
  })
})

describe('content schemas: raw names reach resolve', () => {
  const content = api_schema.content

  it('上传和替换的原始源文件名不会被 schema 去掉或清洗', () => {
    const source_file_name = 'local source.PNG'
    const upload = content.create_task.parse({ story_id: 1, kind: 'upload', payload: { uploads: [{ path: 'ab.png', source_file_name, size: 10, mime_type: null }] } })
    expect(upload.payload).toMatchObject({ uploads: [{ source_file_name }] })
    const replace = content.create_task.parse({ story_id: 1, kind: 'replace', payload: { old_file_name: 'old.png', mode: 'keep-name', file_name: 'local source.PNG', source_file_name, size: 10, mime_type: null, content_type: null } })
    expect(replace.payload).toMatchObject({ source_file_name })
    expect(content.create_task.safeParse({ ... upload, payload: { uploads: [{ path: 'ab.png', source_file_name: '', size: 10, mime_type: null }] } }).success).toBe(false)
    expect(content.create_task.safeParse({ ... replace, payload: { ... replace.payload, source_file_name: '' } }).success).toBe(false)
  })

  it('preflight/create 保留上传原始空格和标点', () => {
    const payload = { uploads: [{ path: 'Thomas’ Calculus in SI Units, 14th Edition.pdf', size: 10, mime_type: 'application/pdf' }] }
    expect(content.preflight_task.safeParse({ story_id: 1, kind: 'upload', payload }).success).toBe(true)
    expect(content.create_task.safeParse({ story_id: 1, kind: 'upload', payload }).success).toBe(true)
  })

  it('replace new-name 保留原始文件名，sanitize 由服务端 resolve 处理', () => {
    expect(content.create_task.safeParse({
      story_id: 1,
      kind: 'replace',
      payload: {
        old_file_name: 'old.png',
        mode: 'new-name',
        size: 10,
        mime_type: 'image/png',
        file_name: 'new photo.PNG',
        content_type: 'image/png',
      },
    }).success).toBe(true)
  })
})
