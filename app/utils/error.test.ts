import { expect, it } from 'vitest'
import { error_message } from './error'

it.each([
  ['User-facing message', 'User-facing message'],
  ['Invalid input: expected string', '输入格式不正确'],
  [new Error('Expected a number'), '输入格式不正确'],
  [{ data: { message: 'Received undefined' }, message: 'Request failed' }, '输入格式不正确'],
  [{ data: { message: '附件已变化' }, message: 'Request failed' }, '附件已变化'],
  [{ error: true, message: '找不到此页', data: { message: 'Nested message' } }, '找不到此页'],
  [{ error: true, message: 'Expected a number', data: { message: 'Nested message' } }, '输入格式不正确'],
  ['用户打断了施法', ''],
  [{ error: true, message: '用户打断了施法' }, ''],
  [new Error('用户打断了施法'), ''],
  ['', ''],
  [{ message: '' }, '不知何错误……'],
  [{ error: true, message: '', data: { message: 'Nested message' } }, '不知何错误……'],
  [null, '不知何错误……'],
])('converts %j into its display message', (input, expected) => {
  expect(error_message(input)).toBe(expected)
})
