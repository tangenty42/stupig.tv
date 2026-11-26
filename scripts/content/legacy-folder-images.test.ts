import { expect, it } from 'vitest'
import { scan_legacy_folder_images } from './legacy-folder-images'

const attachments = [
  { file_name: '照片.good/10.png', is_image: true },
  { file_name: '照片.good/sub/1.png', is_image: true },
  { file_name: '照片.good/2.png.good', is_image: true },
  { file_name: '照片.good/readme.md', is_image: false },
  { file_name: 'notes/sub/a.png', is_image: true },
  { file_name: 'file', is_image: true },
  { file_name: 'file/child.png', is_image: true },
]
const folders = ['空文件夹', '照片.good', '照片.good/sub', 'notes', 'notes/sub']

it('expands direct images in renderer order and retains the caption, title and URL options', () => {
  const markdown = '前缀 ![**说明**](att://%E7%85%A7%E7%89%87.good/?size=1&mode=a#part "描述") 后缀'
  const [match] = scan_legacy_folder_images(markdown, attachments, folders)
  expect(match).toMatchObject({
    path: '照片.good', kind: 'images', line: 1, from: 3,
    replacement: '<carousel>![**说明**](att://照片.good/2.png.good?size=1\\&mode=a#part "描述")![**说明**](att://照片.good/10.png?size=1\\&mode=a#part "描述")</carousel>',
  })
  expect(markdown.slice(match!.from, match!.to)).toBe(match!.source)
})

it('suggests a folder card for an empty directory and flags unidentifiable targets for review', () => {
  const markdown = ['![](att://空文件夹/)', '![说明](att://notes)', '![](att://missing.png)', '![](att://file)',
    '![](https://example.test/照片.good)', '![](照片.good)', '[](att://照片.good)', '![](att://照片.good/10.png)'].join('\n')
  expect(scan_legacy_folder_images(markdown, attachments, folders).map(({ line, kind, replacement }) => ({ line, kind, replacement }))).toEqual([
    { line: 1, kind: 'folder-card', replacement: '[](att://空文件夹)' },
    { line: 2, kind: 'folder-card', replacement: '[](att://notes)' },
    { line: 3, kind: 'missing', replacement: null },
  ])
})

it('keeps original coordinates through CRLF, containers, wrappers and link definitions', () => {
  const markdown = [
    '---', 'cover: ![](att://照片.good)', '---', '',
    '> <carousel>', '> ![**说明**][gallery]', '> </carousel>', '',
    '正文 <good>![](att://空文件夹)</good>', '',
    '<center>', '    ![](att://notes)', '</center>', '',
    '[gallery]: att://照片.good "描述"', '[unused]: att://照片.good',
  ].join('\r\n')
  const matches = scan_legacy_folder_images(markdown, attachments, folders)
  expect(matches.map(({ line, source }) => ({ line, source }))).toEqual([
    { line: 6, source: '![**说明**][gallery]' },
    { line: 9, source: '![](att://空文件夹)' },
    { line: 12, source: '![](att://notes)' },
  ])
  for (const match of matches)
    expect(markdown.slice(match.from, match.to)).toBe(match.source)
  expect(matches[0]?.replacement).toBe('![**说明**](att://照片.good/2.png.good "描述")![**说明**](att://照片.good/10.png "描述")')
})

it('reuses the inline carousel across a nested private wrapper and leaves a single image unwrapped', () => {
  const markdown = '前 <carousel title="照片"><good>![](att://照片.good)</good></carousel> 后 ![](att://照片.good/sub)'
  const matches = scan_legacy_folder_images(markdown, attachments, folders)
  expect(matches.map(match => match.replacement)).toEqual([
    '![](att://照片.good/2.png.good)![](att://照片.good/10.png)',
    '![](att://照片.good/sub/1.png)',
  ])
})

it('does not infer legacy references from comments, fenced or indented code, or raw HTML blocks', () => {
  const markdown = [
    '`![](att://照片.good)`', '', '~~~md', '![](att://照片.good)', '~~~', '',
    '    ![](att://照片.good)', '', '<!-- ![](att://照片.good) -->', '',
    '<pre>', '![](att://照片.good)', '</pre>', '', '\\![](att://照片.good)',
  ].join('\n')
  expect(scan_legacy_folder_images(markdown, attachments, folders)).toEqual([])
})

it('reports separate occurrences of the same reference in one table row', () => {
  const source = '![](att://照片.good)'
  const markdown = `| A | B |\n| --- | --- |\n| ${source} | ${source} |`
  expect(scan_legacy_folder_images(markdown, attachments, folders).map(({ from, line }) => ({ from, line }))).toEqual([
    { from: markdown.indexOf(source), line: 3 },
    { from: markdown.lastIndexOf(source), line: 3 },
  ])
})

it('keeps nested caption images explicit in the enclosing replacement', () => {
  const markdown = '![![图注](att://mini)](att://照片.good)'
  const list = [... attachments, { file_name: 'mini/p.png', is_image: true }]
  const [outer, inner] = scan_legacy_folder_images(markdown, list, folders)
  expect(outer?.replacement).toBe('<carousel>![![图注](att://mini/p.png)](att://照片.good/2.png.good)![![图注](att://mini/p.png)](att://照片.good/10.png)</carousel>')
  expect(inner).toMatchObject({ from: 2, source: '![图注](att://mini)', replacement: '![图注](att://mini/p.png)' })
})

it('groups caption images independently of the carousel around their parent image', () => {
  const markdown = '<carousel>![![](att://照片.good)](att://file)</carousel>'
  const [match] = scan_legacy_folder_images(markdown, attachments, folders)
  expect(match?.replacement).toBe('<carousel>![](att://照片.good/2.png.good)![](att://照片.good/10.png)</carousel>')
})
