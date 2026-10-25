import type { WorkspaceIssue } from '@shared/content-workspace'
import type { ContentWorkspaceNode } from '@shared/types/content'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { attachment_name_key, error_categories, error_policy_schema, workspace_issue } from '@shared/content-workspace'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import { attachment_summary_tree } from '~/utils/content/attachment-list'

const source = readFileSync(new URL('./Resolve.vue', import.meta.url), 'utf8')
// Execute the real grouping and submit handlers; only the UI event boundary is
// replaced, so category-wide policies cannot drift behind a test-only planner.
const setup = source.slice(source.indexOf('const policy ='), source.indexOf('</script>'))
function open(items: WorkspaceIssue[], valid_targets: string[] = [], nodes: ContentWorkspaceNode[] = []) {
  const props = reactive({ resolution: { items, valid_count: valid_targets.length, valid_targets }, nodes, pending: false })
  const emit = vi.fn()
  const scope = effectScope()
  const state = scope.run(() => runInNewContext(`${ts.transpile(setup, { target: ts.ScriptTarget.ES2022 })}; ({ groups, display_groups, expanded_groups, policy, valid_rows, submit_resolution, close, toggle_folder, toggle_group })`, {
    props, emit, reactive, ref, watch, computed, error_categories, error_policy_schema, attachment_name_key, attachment_summary_tree,
  }))!
  return { ... state, props, emit, stop: () => scope.stop() }
}

it.each(error_categories)('keeps %s policies and uses title-only list rows', (category) => {
  const reason = 'Specific reason'
  const f = open([workspace_issue('docs/a.png', category, 'TEST', reason)], ['docs/b.txt'])
  try {
    expect(f.groups.value).toHaveLength(1)
    const group = f.groups.value[0]
    expect(group.category).toBe(category)
    expect(group.title).toBe(category === 'other' || category === 'invalid_name' ? reason : { name_conflict: '名称冲突', reserved: '名称被预约', source_busy: '源正在使用', redacted: '已有删减版' }[category])
    expect(group.rows.map((row: { source: { path: string }, depth: number }) => [row.source.path, row.depth])).toEqual([['docs', 0], ['docs/a.png', 1]])
    expect(group.rows[1].data.file_name).toBe('docs/a.png')
    expect(group.rows[1].upload).toBeNull()
    expect(f.valid_rows.value[1].data.file_name).toBe('docs/b.txt')
    expect(group.allowed.map((item: { value: string }) => item.value)).toContain('skip')
  }
  finally { f.stop() }
})

it('keeps context folders normal, marks only conflicting folders, and folds without changing targets or policies', async () => {
  const f = open([
    workspace_issue('a/b.png', 'name_conflict', 'NAME_TAKEN', '同名'),
    workspace_issue('a/c.png', 'name_conflict', 'NAME_TAKEN', '同名'),
    workspace_issue('a/sub', 'name_conflict', 'NAME_TAKEN', '同名'),
    workspace_issue('a/sub/d.png', 'name_conflict', 'NAME_TAKEN', '同名'),
  ], ['a/ok.txt'])
  try {
    const rows = f.groups.value[0].rows
    expect(rows.map((row: { source: { path: string } }) => row.source.path)).toEqual(['a', 'a/sub', 'a/sub/d.png', 'a/b.png', 'a/c.png'])
    expect(rows[0].state.error).toBe(false)
    expect(rows[1].state.error).toBe(true)
    expect(rows[0].data.collapsed).toBe(false)
    f.toggle_folder(rows[0])
    expect(f.groups.value[0].rows).toHaveLength(1)
    expect(f.groups.value[0].rows[0].data.collapsed).toBe(true)
    expect(f.valid_rows.value).toHaveLength(1)
    expect(f.props.resolution.items).toHaveLength(4)
    expect(f.policy).toEqual(error_policy_schema.parse({}))
    f.toggle_folder(f.groups.value[0].rows[0])
    expect(f.groups.value[0].rows).toHaveLength(5)
    f.toggle_folder(f.groups.value[0].rows[0])
    f.props.resolution = { ... f.props.resolution }
    await nextTick()
    expect(f.groups.value[0].rows).toHaveLength(5)
    expect(source).toContain('role="treeitem" :aria-level="row.depth + 1"')
  }
  finally { f.stop() }
})

it('starts every reason and valid-items section collapsed, toggles independently, and resets on a new batch', async () => {
  const items = [
    workspace_issue('a/b.png', 'name_conflict', 'NAME_TAKEN', '同名'),
    workspace_issue('busy.txt', 'source_busy', 'BUSY', '正在使用'),
  ]
  const f = open(items, ['a/ok.txt'])
  try {
    const sections = f.display_groups.value
    expect(sections.map((group: { title: string }) => group.title)).toEqual(['名称冲突', '源正在使用', '其余 1 项无错误'])
    expect(sections.at(- 1).rows).toEqual(f.valid_rows.value)
    expect(sections.at(- 1).category).toBeNull()
    expect(f.expanded_groups.value.size).toBe(0)
    f.toggle_group(sections[0].key)
    f.toggle_group('valid')
    expect([... f.expanded_groups.value]).toEqual([sections[0].key, 'valid'])
    expect(f.expanded_groups.value.has(sections[1].key)).toBe(false)
    f.toggle_folder(sections[0].rows[0])
    f.toggle_group(sections[0].key)
    f.toggle_group(sections[0].key)
    expect(f.groups.value[0].rows).toHaveLength(1)
    expect(f.policy).toEqual(error_policy_schema.parse({}))
    expect(f.props.resolution.items).toHaveLength(2)
    f.props.resolution = { items, valid_count: 0, valid_targets: [] }
    await nextTick()
    expect(f.expanded_groups.value.size).toBe(0)
    expect(f.display_groups.value).toHaveLength(2)
  }
  finally { f.stop() }
})

it('uses the private source styling for a redacted conflict even if a public file has the same displayed name', () => {
  const file = { file_name: 'image.avif', mime_type: 'image/avif', file_size: 20, version: 'v1', is_image: true, is_encrypted: false, url: null }
  const public_node: ContentWorkspaceNode = { id: 1, parent_id: 2, path: file.file_name, name: file.file_name, kind: 'file', version: 'v1', attachment: file }
  const private_node: ContentWorkspaceNode = { ... public_node, id: 3, path: `${file.file_name}.good`, name: `${file.file_name}.good`, attachment: { ... file, is_private: true, has_redacted: true } }
  const f = open([workspace_issue(file.file_name, 'redacted', 'REDACTED_EXISTS', '已有删减版')], [], [public_node, private_node])
  try {
    expect(f.groups.value[0].rows[0].data).toMatchObject({ is_private: true, has_redacted: true })
  }
  finally { f.stop() }
})

it('separates distinct reasons without broadening the shared category policy', () => {
  const items = [
    workspace_issue('one.txt', 'other', 'GONE', '目标不存在'),
    { ... workspace_issue('two.txt', 'other', 'BUSY', '原附件已有未完成传输'), allowed: ['fail'] as const },
    workspace_issue('three.txt', 'other', 'GONE', '目标不存在'),
  ].map(item => ({ ... item, allowed: [... item.allowed] }))
  const f = open(items)
  try {
    expect(f.groups.value.map((group: { title: string }) => group.title)).toEqual(['目标不存在', '原附件已有未完成传输'])
    expect(f.groups.value[0].rows.map((row: { data: { file_name: string } }) => row.data.file_name)).toEqual(['one.txt', 'three.txt'])
    expect(f.groups.value[1].rows[0].data.file_name).toBe('two.txt')
    for (const group of f.groups.value)
      expect(group.allowed.map((item: { value: string }) => item.value)).toEqual(['fail'])
    f.policy.other = 'fail'
    f.submit_resolution()
    expect(f.emit).toHaveBeenCalledWith('submit', error_policy_schema.parse({}))
  }
  finally { f.stop() }
})

it.each([
  ['name_conflict', 'suffix'], ['reserved', 'suffix'], ['source_busy', 'skip'],
  ['invalid_name', 'sanitize'], ['other', 'skip'], ['redacted', 'skip'],
] as const)('retries %s with the chosen %s policy', (category, action) => {
  const f = open([workspace_issue('one.txt', category, 'TEST', '原因')], ['valid.txt'])
  try {
    f.policy[category] = action
    f.submit_resolution()
    expect(f.emit).toHaveBeenCalledExactlyOnceWith('submit', error_policy_schema.parse({ [category]: action }))
  }
  finally { f.stop() }
})

it.each(['fail', 'keep', 'discard'] as const)('keeps redacted %s behavior under the fixed retry button', (action) => {
  const f = open([workspace_issue('image.avif', 'redacted', 'REDACTED_EXISTS', '重复描述')])
  try {
    expect(f.groups.value[0].allowed.map((item: { value: string }) => item.value)).toEqual(['fail', 'keep', 'discard'])
    f.policy.redacted = action
    f.submit_resolution()
    if (action === 'fail') {
      expect(f.emit).toHaveBeenCalledExactlyOnceWith('close')
    }
    else {
      expect(f.emit).toHaveBeenCalledExactlyOnceWith('submit', error_policy_schema.parse({ redacted: action }))
    }
    const conflict_template = source.slice(0, source.indexOf('<div v-else-if="report"'))
    expect(source).toContain('label="重试"')
    expect(conflict_template).toContain('<MyContentAttachmentCard')
    expect(conflict_template).not.toContain('item.reason')
  }
  finally { f.stop() }
})

it('blocks repeat submits and dismissal while pending, then resets policies for the next batch', async () => {
  const f = open([workspace_issue('one.txt', 'name_conflict', 'NAME_TAKEN', '同名')])
  try {
    expect(f.groups.value[0].allowed.map((item: { value: string }) => item.value)).toEqual(['fail', 'suffix'])
    f.policy.name_conflict = 'suffix'
    f.props.pending = true
    f.submit_resolution()
    f.close()
    expect(f.emit).not.toHaveBeenCalled()
    f.props.pending = false
    f.submit_resolution()
    expect(f.emit).toHaveBeenCalledExactlyOnceWith('submit', error_policy_schema.parse({ name_conflict: 'suffix' }))
    f.props.resolution = { items: [workspace_issue('next.txt', 'reserved', 'UPLOAD_RESERVED', '被预约')], valid_count: 0, valid_targets: [] }
    await nextTick()
    expect(f.policy).toEqual(error_policy_schema.parse({}))
  }
  finally { f.stop() }
})
