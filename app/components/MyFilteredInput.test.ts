import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { link_file_name_illegal_chars } from '@shared/content-markdown'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

function input(modelValue = '', replacement = '_') {
  // Exercise the existing component's input/IME handlers with only the native
  // input boundary substituted. Real caret/composition rendering is browser QA.
  const source = readFileSync(new URL('./MyFilteredInput.vue', import.meta.url), 'utf8')
  const handlers = source.slice(source.indexOf('const input_component = '), source.indexOf('</script>'))
  const props = { modelValue, filter: link_file_name_illegal_chars, replacement }
  const emit = vi.fn()
  const el = { value: modelValue, selectionStart: modelValue.length, selectionEnd: modelValue.length, setSelectionRange: vi.fn() }
  const context = runInNewContext(`${ts.transpile(handlers)}; ({ input_component, ime_composing, on_update, on_composition_end })`, { ref, nextTick, props, emit })
  context.input_component.value = { $el: el }
  return { ... context, props, emit, el }
}

it('replaces forbidden filename characters in both model and visible input, even when the clean model is unchanged', async () => {
  const field = input('文件_名')
  field.el.value = '文件/名'
  field.el.selectionStart = field.el.selectionEnd = 3
  field.on_update(field.el.value)
  expect(field.emit).toHaveBeenLastCalledWith('update:modelValue', '文件_名')
  expect(field.el.value).toBe('文件_名')
  await nextTick()
  expect(field.el.setSelectionRange).toHaveBeenLastCalledWith(3, 3)
  const raw = '中文 <>:"?*|()[]\\/#@&=%`\n正文'
  field.el.value = raw
  field.on_update(raw)
  expect(field.emit.mock.calls.at(- 1)?.[1]).toBe(raw.replace(link_file_name_illegal_chars, '_'))
})

it('keeps Chinese composition unfiltered, then cleans the actual final DOM value', () => {
  const field = input('旧值')
  field.ime_composing.value = true
  field.el.value = '中文/完成'
  field.on_update('中文/')
  expect(field.emit).toHaveBeenLastCalledWith('update:modelValue', '中文/')
  // Parent props may lag behind the compositionend event.
  field.on_composition_end()
  expect(field.emit).toHaveBeenLastCalledWith('update:modelValue', '中文_完成')
  expect(field.el.value).toBe('中文_完成')
})

it('keeps the caret at the edit when a caller removes filtered characters', async () => {
  const field = input('ab', '')
  field.el.value = '/a/b'
  field.el.selectionStart = field.el.selectionEnd = 3
  field.on_update(field.el.value)
  await nextTick()
  expect(field.el.value).toBe('ab')
  expect(field.el.setSelectionRange).toHaveBeenLastCalledWith(1, 1)
})
