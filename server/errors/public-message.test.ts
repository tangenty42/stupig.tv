import { ApiError } from '@server/errors/ApiError'
import { INTERNAL_ERROR_MESSAGE, public_error_message } from '@server/errors/public-message'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

describe('public_error_message', () => {
  it('keeps ApiError messages in every environment', () => {
    expect(public_error_message(new ApiError(409, '文件名已存在'), false)).toBe('文件名已存在')
    expect(public_error_message(new ApiError(409, '文件名已存在'), true)).toBe('文件名已存在')
  })

  it('keeps custom Zod refinement messages but not internal type messages', () => {
    const custom = z.string().refine(() => false, { message: '名字不合法' }).safeParse('x')
    const internal = z.string().safeParse(1)

    expect(public_error_message(custom.error, false)).toBe('名字不合法')
    expect(public_error_message(internal.error, false)).toBe('请求参数不合法！')
  })

  it('hides internal error details in production', () => {
    const error = new Error('connect ECONNREFUSED 10.0.0.2:3306')

    expect(public_error_message(error, false)).toBe(INTERNAL_ERROR_MESSAGE)
  })

  it('passes internal error details through in development', () => {
    const error = new Error('connect ECONNREFUSED 10.0.0.2:3306')

    expect(public_error_message(error, true)).toBe('connect ECONNREFUSED 10.0.0.2:3306')
  })

  it('hides non-Error throws in production', () => {
    expect(public_error_message('raw db dump', false)).toBe(INTERNAL_ERROR_MESSAGE)
  })
})
