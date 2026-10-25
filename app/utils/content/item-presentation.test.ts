import { describe, expect, it } from 'vitest'
import { attachment_item_presentation, folder_item_presentation } from './item-presentation'

describe('content item presentation', () => {
  const file = { file_name: 'photo.png', mime_type: 'image/png' }

  it('keeps file type icons and distinguishes private and redacted files without badges', () => {
    expect(attachment_item_presentation(file)).toEqual({ icon: 'lucide:file-image', tone: 'muted' })
    expect(attachment_item_presentation({ ... file, is_private: true })).toEqual({ icon: 'lucide:lock', tone: 'private' })
    expect(attachment_item_presentation({ ... file, is_private: true, has_redacted: true })).toEqual({ icon: 'lucide:lock', tone: 'redacted' })
    expect(attachment_item_presentation({ ... file, is_private: false, has_redacted: true })).toEqual({ icon: 'lucide:file-image', tone: 'muted' })
    const cached_legacy = { ... file, is_abridged_twin: true, redaction_source_id: 8 }
    expect(attachment_item_presentation(cached_legacy)).toEqual({ icon: 'lucide:file-image', tone: 'muted' })
    expect(attachment_item_presentation({ file_name: 'archive.zip', mime_type: null })).toEqual({ icon: 'lucide:file-archive', tone: 'muted' })
  })

  it('prioritizes transfer errors and activity over the stored file color', () => {
    expect(attachment_item_presentation({ ... file, is_private: true }, 'error')).toEqual({ icon: 'lucide:lock', tone: 'error' })
    expect(attachment_item_presentation({ ... file, is_private: true, has_redacted: true }, 'error')).toEqual({ icon: 'lucide:lock', tone: 'error' })
    for (const status of ['queued', 'uploading', 'paused'])
      expect(attachment_item_presentation(file, status)).toEqual({ icon: 'lucide:file-image', tone: 'active' })
    for (const status of ['queued', 'uploading', 'paused'])
      expect(attachment_item_presentation({ ... file, is_private: true, has_redacted: true }, status)).toEqual({ icon: 'lucide:lock', tone: 'active' })
  })

  it('uses the folder disclosure icon for both lists', () => {
    expect(folder_item_presentation()).toEqual({ icon: 'lucide:chevron-right', tone: 'muted' })
    expect(folder_item_presentation(true)).toEqual({ icon: 'lucide:chevron-down', tone: 'muted' })
    expect(folder_item_presentation(false, true)).toEqual({ icon: 'lucide:chevron-right', tone: 'error' })
    expect(folder_item_presentation(true, true)).toEqual({ icon: 'lucide:chevron-down', tone: 'error' })
    expect(folder_item_presentation(true, false, true)).toEqual({ icon: 'lucide:chevron-down', tone: 'private' })
    expect(folder_item_presentation(true, true, true).tone).toBe('error')
  })

  it('uses the private lock and color for inherited files and pending upload paths', () => {
    const inherited = { ... file, file_name: 'private.good/sub/photo.png' }
    expect(attachment_item_presentation(inherited)).toEqual({ icon: 'lucide:lock', tone: 'private' })
    expect(attachment_item_presentation(inherited, 'uploading')).toEqual({ icon: 'lucide:lock', tone: 'active' })
    expect(attachment_item_presentation({ ... inherited, has_redacted: true }).tone).toBe('redacted')
    const cached_legacy = { ... inherited, is_abridged_twin: true }
    expect(attachment_item_presentation(cached_legacy)).toEqual({ icon: 'lucide:lock', tone: 'private' })
  })
})
