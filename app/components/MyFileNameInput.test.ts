import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('shares the filename filter and fixed-suffix control between rename and image save dialogs', () => {
  // This is a component-wiring invariant; the filter handlers have runtime
  // coverage beside MyFilteredInput, and real rendering is checked in Chrome.
  const component = readFileSync(new URL('./MyFileNameInput.vue', import.meta.url), 'utf8')
  expect(component).toContain('<MyFilteredInput')
  expect(component).toContain(':filter="link_file_name_illegal_chars"')
  expect(component).toContain('v-bind="$attrs"')
  expect(component).toMatch(/<InputGroupAddon v-if="suffix"[^>]*aria-label="固定后缀"[^>]*>[\s\S]*?\{\{ suffix \}\}/)
  const workspace = readFileSync(new URL('./MyContent/Attachment/Workspace.vue', import.meta.url), 'utf8')
  const image = readFileSync(new URL('./MyContent/Attachment/ImageEditor.vue', import.meta.url), 'utf8')
  expect(workspace).toContain('<MyFileNameInput v-model="name" :suffix="name_suffix"')
  expect(workspace).toContain('@keydown.enter="submit_name"')
  expect(image).toContain('<MyFileNameInput v-model="display_name"')
  expect(image).toContain(':suffix="mode === \'copy\' ? \'.avif\' : original_name.locked"')
  expect(image).toContain('{ label: \'另存为\', value: \'copy\' }')
})
