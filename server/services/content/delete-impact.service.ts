import type { ContentDeleteImpact, ContentDeleteTarget } from '@shared/types/content-delete-impact'
import type { RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { redaction_rows } from '@server/services/content-attachments.service'
import { find_delete_references } from '@shared/content-delete-impact'
import { attachment_path_is_private, front_matter_line_count } from '@shared/content-markdown'
import { redact_private_content_with_source_map } from '@shared/content-private'
import { content_name_key, format_attachment_ref } from '@shared/content-reference'

interface DeleteAttachmentRow extends RowDataPacket {
  id: number
  file_name: string
  is_folder: number
  is_private: number
  object_key: string | null
}

/** A read-only preview, limited to the caller's visible representation. */
export async function get_delete_impact(input: { kind: 'story', id: number } | { kind: 'attachment', id: number, targets: number[] }, can_private: boolean): Promise<ContentDeleteImpact> {
  const [found] = await db.execute<RowDataPacket[]>('SELECT id, title, markdown, cover FROM content_stories WHERE id = ?', [input.id])
  if (! found[0])
    throw new ApiError(404, '档案不存在或已被删除')
  let targets: ContentDeleteTarget[]
  let stories: RowDataPacket[]
  const folders: string[] = []
  const file_privacy = new Map<string, boolean>()
  if (input.kind === 'story') {
    targets = [{ path: String(found[0].title), kind: 'story' }]
    ;[stories] = await db.execute<RowDataPacket[]>('SELECT id, title, markdown FROM content_stories WHERE id != ? ORDER BY id', [input.id])
  }
  else {
    const [attachments] = await db.execute<DeleteAttachmentRow[]>('SELECT id, file_name, is_folder, is_private, object_key FROM content_story_attachments WHERE story_id = ?', [input.id])
    const selected = new Set(input.targets)
    const nodes = attachments.filter(node => selected.has(Number(node.id)))
    if (nodes.length !== selected.size || nodes.some(node => ! node.file_name))
      throw new ApiError(409, '附件已变化，请刷新后重试')
    const redactions = redaction_rows(attachments)
    const source_paths = new Map<number, string>()
    for (const attachment of attachments) {
      if (attachment.is_folder)
        folders.push(attachment.file_name)
      else
        file_privacy.set(content_name_key(attachment.file_name), Boolean(attachment.is_private))
      const redaction = redactions.get(Number(attachment.id))
      if (redaction)
        source_paths.set(Number(redaction.id), attachment.file_name)
    }
    targets = nodes.map((node) => {
      const redaction_of = source_paths.get(Number(node.id))
      return { path: node.file_name, kind: node.is_folder ? 'folder' : 'file', ... (redaction_of ? { redaction_of } : {}) }
    })
    stories = found
  }
  const private_cover = (name: string) => file_privacy.get(content_name_key(name)) ?? attachment_path_is_private(name)
  const sources = stories.flatMap((story) => {
    const visible = can_private ? { markdown: String(story.markdown), source_lines: undefined } : redact_private_content_with_source_map(String(story.markdown))
    const cover_lines = ! can_private && input.kind === 'attachment' ? front_matter_line_count(visible.markdown) : 0
    const references = find_delete_references(visible.markdown, targets, folders)
      .filter(item => item.line > cover_lines || ! private_cover(item.target))
      .map(item => ({
        ... item, line: visible.source_lines ? (visible.source_lines[item.line - 1] ?? item.line - 1) + 1 : item.line,
      }))
    // Preserve the stored cover check even if historical metadata has drifted
    // from the Markdown; do not expose a hidden confidential cover path.
    const cover = input.kind === 'attachment' ? String(story.cover ?? '') : ''
    if (cover && (can_private || ! private_cover(cover))) {
      const cover_refs = find_delete_references(`---\ncover: ${format_attachment_ref(cover)}\n---`, targets, folders)
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
    cloud_draft_references = drafts.some(draft => find_delete_references(String(draft.markdown), targets, folders).length > 0)
  }
  return { targets: can_private ? targets : targets.map(({ path, kind }) => ({ path, kind })), sources, cloud_draft_references }
}
