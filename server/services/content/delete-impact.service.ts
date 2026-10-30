import type { ContentDeleteImpact, ContentDeleteTarget } from '@shared/types/content-delete-impact'
import type { RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { find_delete_references } from '@shared/content-delete-impact'
import { attachment_path_is_private } from '@shared/content-markdown'
import { redact_private_content_with_source_map } from '@shared/content-private'
import { content_name_key, format_attachment_ref } from '@shared/content-reference'

/** A read-only preview, limited to the caller's visible representation. */
export async function get_delete_impact(input: { kind: 'story', id: number } | { kind: 'attachment', id: number, targets: number[] }, can_private: boolean): Promise<ContentDeleteImpact> {
  const [found] = await db.execute<RowDataPacket[]>('SELECT id, title, markdown, cover FROM content_stories WHERE id = ?', [input.id])
  if (! found[0])
    throw new ApiError(404, '档案不存在或已被删除')
  let targets: ContentDeleteTarget[]
  let stories: RowDataPacket[]
  if (input.kind === 'story') {
    targets = [{ path: String(found[0].title), kind: 'story' }]
    ;[stories] = await db.execute<RowDataPacket[]>('SELECT id, title, markdown FROM content_stories WHERE id != ? ORDER BY id', [input.id])
  }
  else {
    const [nodes] = await db.execute<RowDataPacket[]>(`SELECT id, file_name, is_folder FROM content_story_attachments WHERE story_id = ? AND id IN (${input.targets.map(() => '?').join(', ')})`, [input.id, ... input.targets])
    if (nodes.length !== new Set(input.targets).size || nodes.some(node => ! node.file_name))
      throw new ApiError(409, '附件已变化，请刷新后重试')
    targets = nodes.map(node => ({ path: String(node.file_name), kind: node.is_folder ? 'folder' : 'file' }))
    stories = found
  }
  const sources = stories.flatMap((story) => {
    const visible = can_private ? { markdown: String(story.markdown), source_lines: undefined } : redact_private_content_with_source_map(String(story.markdown))
    const references = find_delete_references(visible.markdown, targets).map(item => ({
      ... item, line: visible.source_lines ? (visible.source_lines[item.line - 1] ?? item.line - 1) + 1 : item.line,
    }))
    // Preserve the stored cover check even if historical metadata has drifted
    // from the Markdown; do not expose a hidden confidential cover path.
    const cover = input.kind === 'attachment' ? String(story.cover ?? '') : ''
    if (cover && (can_private || ! attachment_path_is_private(cover))) {
      const cover_refs = find_delete_references(`---\ncover: ${format_attachment_ref(cover)}\n---`, targets)
      for (const item of cover_refs) {
        if (! references.some(ref => content_name_key(ref.target) === content_name_key(item.target) && ref.effect === item.effect))
          references.push({ ... item, line: 0 })
      }
    }
    return references.length ? [{ story_id: Number(story.id), title: String(story.title), references }] : []
  })
  let cloud_draft_references = false
  if (can_private) {
    const [drafts] = await db.execute<RowDataPacket[]>(`SELECT markdown FROM content_story_drafts ${input.kind === 'attachment' ? 'WHERE story_id = ?' : 'WHERE story_id IS NULL OR story_id != ?'}`, [input.id])
    cloud_draft_references = drafts.some(draft => find_delete_references(String(draft.markdown), targets).length > 0)
  }
  return { targets, sources, cloud_draft_references }
}
