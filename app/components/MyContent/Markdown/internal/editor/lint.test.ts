import { Text } from '@codemirror/state'
import { expect, it } from 'vitest'
import { build_diagnostics, story_lint_config } from './lint'

it('groups story, attachment and iframe diagnostics under outer-refs', () => {
  const source = [
    '---',
    'title: 测试',
    'time: 2026/1/1',
    '---',
    '[](content://不存在)',
    '[](att://missing.png)',
    '[视频](iframe://player.bilibili.com/player.html?bvid=BV1Pvnd6JEVD)',
  ].join('\n')
  const doc = Text.of(source.split('\n'))
  const config = story_lint_config({ titleMaxLength: 100, labelMaxBytes: 100, descMaxBytes: 100, coverMaxBytes: 100, markdownMaxBytes: 10000 }, [], null)
  const diagnostics = build_diagnostics(source, doc, config)
  for (const message of ['档案『不存在』不可引用', '附件『missing.png』不存在', 'iframe:// 只能用于图片语法 ![标题](iframe://...)']) {
    expect(diagnostics).toContainEqual(expect.objectContaining({ source: 'outer-refs', severity: 'warning', message }))
  }
})
