import type { ContentStoryAttachment } from '@shared/types/content'
import { expect, it, vi } from 'vitest'
import { create_upload_completion_context } from './upload-completion'

const attachment = { id: 9 } as ContentStoryAttachment
it('delivers once only to a live originating editor context', () => {
  const context = create_upload_completion_context()
  const inserted = vi.fn()
  const landed = context.bind(inserted)
  landed(attachment)
  landed(attachment)
  expect(inserted).toHaveBeenCalledOnce()
  const late = context.bind(inserted)
  context.dispose()
  late(attachment)
  context.bind(inserted)(attachment)
  expect(inserted).toHaveBeenCalledOnce()
})

it('invalidates old identity tickets while allowing the next editor identity', () => {
  const context = create_upload_completion_context()
  const old = vi.fn()
  const next = vi.fn()
  const late = context.bind(old)
  context.reset()
  context.bind(next)(attachment)
  late(attachment)
  expect(old).not.toHaveBeenCalled()
  expect(next).toHaveBeenCalledOnce()
})
