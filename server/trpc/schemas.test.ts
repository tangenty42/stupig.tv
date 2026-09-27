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
