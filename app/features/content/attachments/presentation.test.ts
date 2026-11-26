import { describe, expect, it } from 'vitest'
import { attachment_item_presentation, folder_item_presentation } from './presentation'

describe('content item presentation', () => {
  const file = { file_name: 'photo.png', mime_type: 'image/png' }

  it('keeps file type icons and distinguishes private and redacted files without badges', () => {
    expect(attachment_item_presentation(file)).toEqual({ icon: 'lucide:file-image', tone: 'muted' })
    expect(attachment_item_presentation({ ... file, is_private: true })).toEqual({ icon: 'lucide:file-image', tone: 'private' })
    expect(attachment_item_presentation({ ... file, is_private: false, is_redaction: true })).toEqual({ icon: 'lucide:file-image', tone: 'redacted' })
    const cached_legacy = { ... file, is_abridged_twin: true, redaction_source_id: 8 }
    expect(attachment_item_presentation(cached_legacy)).toEqual({ icon: 'lucide:file-image', tone: 'muted' })
    expect(attachment_item_presentation({ file_name: 'archive.zip', mime_type: null })).toEqual({ icon: 'lucide:file-archive', tone: 'muted' })
  })

  it('prioritizes transfer errors and activity over the stored file color', () => {
    expect(attachment_item_presentation({ ... file, is_private: true }, 'error')).toEqual({ icon: 'lucide:file-image', tone: 'error' })
    expect(attachment_item_presentation({ ... file, is_private: false, is_redaction: true }, 'error')).toEqual({ icon: 'lucide:file-image', tone: 'error' })
    for (const status of ['queued', 'uploading', 'paused'])
      expect(attachment_item_presentation(file, status)).toEqual({ icon: 'lucide:file-image', tone: 'active' })
    for (const status of ['queued', 'uploading', 'paused'])
      expect(attachment_item_presentation({ ... file, is_private: false, is_redaction: true }, status)).toEqual({ icon: 'lucide:file-image', tone: 'active' })
  })

  it('uses the folder disclosure icon for both lists', () => {
    expect(folder_item_presentation()).toEqual({ icon: 'lucide:chevron-right', tone: 'muted' })
    expect(folder_item_presentation(true)).toEqual({ icon: 'lucide:chevron-down', tone: 'muted' })
    expect(folder_item_presentation(false, true)).toEqual({ icon: 'lucide:chevron-right', tone: 'error' })
    expect(folder_item_presentation(true, true)).toEqual({ icon: 'lucide:chevron-down', tone: 'error' })
    expect(folder_item_presentation(true, false, true)).toEqual({ icon: 'lucide:chevron-down', tone: 'private' })
    expect(folder_item_presentation(true, true, true).tone).toBe('error')
  })

  it('keeps file type icons for inherited privacy and recognizes the extension before a private suffix', () => {
    const inherited = { ... file, file_name: 'private.good/sub/photo.png' }
    expect(attachment_item_presentation(inherited)).toEqual({ icon: 'lucide:file-image', tone: 'private' })
    expect(attachment_item_presentation({ file_name: 'photo.png.good', mime_type: null }, 'uploading')).toEqual({ icon: 'lucide:file-image', tone: 'active' })
    expect(attachment_item_presentation({ file_name: 'archive.zip.good', mime_type: null })).toEqual({ icon: 'lucide:file-archive', tone: 'private' })
    expect(attachment_item_presentation({ ... inherited, is_private: false, is_redaction: true })).toEqual({ icon: 'lucide:file-image', tone: 'redacted' })
  })
})
