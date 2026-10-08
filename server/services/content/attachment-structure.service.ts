import type { ContentAttachmentBatchResult, ContentBatchSkipped, ContentOperationKind, ContentStoryAttachment } from '@shared/types/content'
import type { Connection, RowDataPacket } from 'mysql2/promise'
import { extname } from 'node:path'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { acquire_operation_lock, get_operation_lock, release_operation_lock } from '@server/lib/operation-lock'
import { random_file_token } from '@server/lib/random'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { create_folder_rows, delete_folder_rows, delete_rows_by_ids, get_scope_attachment, list_folder_subtree_rows, list_scope_attachments, list_scope_folders, list_scope_paths, list_scope_rows, rename_attachment_row, rename_row_by_id } from '@server/services/content-attachments.service'
import { get_story, update_story } from '@server/services/content/story.service'
import { runtime_config } from '@shared/config'
import { attachment_ancestor_folders, attachment_base_name, attachment_folder_of, attachment_name_conflict_message, attachment_path_join, attachment_path_taken, attachment_path_violation, decrypted_attachment_name, encrypted_attachment_suffix, is_encrypted_attachment, link_file_name_byte_length, normalized_attachment_extension, rename_attachment_references, sanitize_attachment_segment } from '@shared/content-markdown'

const config = runtime_config()

/** Attachment files and explicit folders of a story's scope. */
async function attachment_scope_payload(story_id: number) {
  return {
    attachments: await list_scope_attachments(story_id),
    folders: await list_scope_folders(story_id),
    operation_lock: await get_operation_lock(story_id),
  }
}

export function publish_attachment_refresh(story_id: number) {
  publish_refresh({ resource: sync_resource('content_story', story_id) })
}

/**
 * Announces a finished attachment change.
 *
 * `content_stories.updated_at` is the token subscribers pass as `base_updated_at`
 * to skip refetching an unchanged story, and attachment rows live in their own
 * table — so a change that leaves the story row alone (an upload, a folder, a
 * rename of an unreferenced file) has to bump it here, or every connected client
 * would keep rendering the attachment list it already had. The bump also
 * reorders the story list, which sorts by it.
 */
export async function publish_attachment_change(story_id: number) {
  await db.execute('UPDATE content_stories SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [story_id])
  publish_attachment_refresh(story_id)
}

/**
 * Runs an attachment structure change under the scope's operation lock.
 *
 * The lock is broadcast on acquire and release as part of the attachment
 * payload, so peers disable the same controls instead of racing into a 409.
 * Peers refetching mid-operation read the pre-operation rows (the row rewrites
 * are still uncommitted), so they never observe the intermediate move names.
 *
 * Uploads and in-place replacement deliberately stay outside: they hold an OSS
 * transfer for the bulk of their lifetime (which could outlive the lease),
 * name themselves around collisions, and are additive rather than
 * renames of names other operations already resolved.
 */
export async function with_attachment_lock<T>(story_id: number, kind: ContentOperationKind, fn: () => Promise<T>): Promise<T> {
  const lock = await acquire_operation_lock(story_id, kind)
  publish_attachment_refresh(story_id)
  try {
    return await fn()
  }
  finally {
    // A release failure only leaves the lease to lapse; it must not mask the
    // operation's own error or fail an otherwise successful change.
    await release_operation_lock(lock).catch(() => {})
    publish_attachment_refresh(story_id)
  }
}

interface StoryMarkdownRow extends RowDataPacket {
  markdown: string
  cover: string
}

/**
 * Applies attachment renames to a story's markdown and cover.
 *
 * The row is re-read under `FOR UPDATE` instead of reusing the copy fetched
 * while planning: attachment changes and saves both rewrite `markdown`
 * wholesale, so applying a rename to a stale copy would silently drop a save
 * that committed in between (and vice versa).
 *
 * A reference rewrite bumps `revision`, unlike the cross-story `@title`
 * cascade below. Here the rename and a save write the same field of the same
 * story, so an editor holding the pre-rename markdown must not be allowed to
 * save it back: without the bump, that save would overwrite the rewrite and
 * leave the document pointing at a name that no longer exists. Bumping turns
 * it into the ordinary version conflict the editor already resolves.
 */
export async function rewrite_story_attachment_refs(connection: Connection, story_id: number, renames: { old_file_name: string, new_file_name: string }[]) {
  if (! renames.length)
    return
  const [rows] = await connection.execute<StoryMarkdownRow[]>(
    'SELECT markdown, cover FROM content_stories WHERE id = ? FOR UPDATE',
    [story_id],
  )
  const story = rows[0]
  if (! story)
    return

  let markdown = story.markdown
  let cover = story.cover ?? ''
  for (const rename of renames) {
    markdown = rename_attachment_references(markdown, rename.old_file_name, rename.new_file_name)
    if (cover === rename.old_file_name)
      cover = rename.new_file_name
  }
  if (markdown !== story.markdown || cover !== (story.cover ?? '')) {
    await connection.execute(
      'UPDATE content_stories SET markdown = ?, cover = ?, revision = revision + 1 WHERE id = ?',
      [markdown, cover, story_id],
    )
  }
}

/** Persists a folder (and missing ancestors) in a scope. */
export async function create_folder(story_id: number, folder: string) {
  await with_attachment_lock(story_id, 'folder_create', async () => {
    await get_story(story_id)
    // A name is one path for both kinds: a file already answering to it — or
    // holding contents that make the name a folder in its own right — keeps the
    // folder from existing under it.
    const folder_path = resolve_attachment_name(folder, await list_scope_paths(story_id), 'reject')
    await create_folder_rows(story_id, [... attachment_ancestor_folders(folder_path), folder_path])
    await publish_attachment_change(story_id)
  })
  // Read after the lock is released, so the payload reports the scope as idle
  // instead of echoing the caller's own finished operation back as in flight.
  return attachment_scope_payload(story_id)
}

/** Removes a folder row subtree; files beneath make it a 409. */
export async function delete_folder(story_id: number, folder: string) {
  await with_attachment_lock(story_id, 'folder_delete', async () => {
    await get_story(story_id)
    await delete_folder_rows(story_id, folder)
    await publish_attachment_change(story_id)
  })
  return attachment_scope_payload(story_id)
}

/**
 * Moves/renames a folder: every row of its subtree (files, subfolders and the
 * source folder row itself — no empty folder is left behind) gets the new
 * prefix; story markdown/cover references follow. A folder row landing where a
 * folder already exists merges into it (dropping `a/a` onto the root yields
 * `a`, not a conflict); files still refuse a taken path with a 409.
 */
export async function move_folder(story_id: number, source_folder: string, new_folder: string) {
  if (new_folder === source_folder)
    return attachment_scope_payload(story_id)
  if (new_folder.startsWith(`${source_folder}/`))
    throw new ApiError(400, '不能移动到文件夹自身内部')

  await with_attachment_lock(story_id, 'move', async () => {
    const story = await get_story(story_id)

    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      // Planned inside the transaction: the listing, the collision checks and
      // the rewrite must not be separated by another writer.
      const subtree = await list_folder_subtree_rows(story_id, source_folder, connection)
      if (! subtree.length)
        throw new ApiError(404, '文件夹不存在或已被删除')
      const subtree_ids = new Set(subtree.map(row => row.id))
      const remaining = (await list_scope_rows(story_id, connection)).filter(row => ! subtree_ids.has(row.id))
      const remaining_folders = new Set(remaining.filter(row => row.is_folder).map(row => row.file_name.toLowerCase()))
      const remaining_files = new Set(remaining.filter(row => ! row.is_folder).map(row => row.file_name.toLowerCase()))
      const remaining_paths = remaining.map(row => row.file_name)

      const renames: { old_file_name: string, new_file_name: string }[] = []
      const moves: { id: number, new_file_name: string }[] = []
      const merged: number[] = []
      // The destination has to be a legal name in its own right (the `.good`
      // check applies to folders too); landing on a folder that already answers
      // to it is the documented merge, so that conflict is allowed here and the
      // per-row checks below decide the rest.
      const destination = resolve_attachment_name(new_folder, remaining_paths, 'merge')
      for (const row of subtree) {
        const new_file_name = `${destination}${row.file_name.slice(source_folder.length)}`
        if (row.is_folder) {
          const lower = new_file_name.toLowerCase()
          if (remaining_folders.has(lower))
            merged.push(row.id)
          else if (remaining_files.has(lower))
            throw new ApiError(409, attachment_name_conflict_message)
          else
            moves.push({ id: row.id, new_file_name })
        }
        else {
          // Derived from the row, so it may carry the `.good` marker: only its
          // availability is checked, never its legality.
          assert_attachment_name_available(new_file_name, remaining_paths)
          moves.push({ id: row.id, new_file_name })
          renames.push({ old_file_name: row.file_name, new_file_name })
        }
      }

      // Two-phase rename: a destination may still be another subtree row's
      // source (moving onto an ancestor path, e.g. a/a → a), and the unique
      // index forbids holding that name even mid-batch. The transaction keeps
      // a failure between the loops from stranding rows under `.mvtmp-` names.
      for (const row of subtree)
        await rename_row_by_id(row.id, `.mvtmp-${crypto.randomUUID()}`, connection)
      await delete_rows_by_ids(merged, connection)
      for (const move of moves)
        await rename_row_by_id(move.id, move.new_file_name, connection)
      // The destination becomes a folder of its own, ancestors included. Files
      // otherwise carry a folder's existence implicitly, so renaming onto a
      // path no row answers to would leave the renamed folder to vanish as soon
      // as its last file moved away. Existing rows are kept, so a merge is free.
      if (moves.some(move => move.new_file_name.startsWith(`${destination}/`)))
        await create_folder_rows(story_id, [... attachment_ancestor_folders(destination), destination], connection)
      await rewrite_story_attachment_refs(connection, story.id, renames)
      await connection.commit()
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally {
      connection.release()
    }

    await publish_attachment_change(story_id)
  })
  return attachment_scope_payload(story_id)
}

/** Rebuilds a taken file name with a random suffix before the extension, keeping the byte cap and folder prefix. */
function suffixed_attachment_name(file_name: string, ext: string) {
  const base = attachment_base_name(file_name)
  const stem = ext ? base.slice(0, - ext.length) : base
  const suffix = `-${random_file_token()}`
  const stem_limit = config.app.content.link.fileNameMaxBytes - link_file_name_byte_length(suffix) - link_file_name_byte_length(ext)
  // The stem is not a file name — the extension is appended separately and
  // already lowercased by the caller — so this cleans the segment only.
  return attachment_path_join(attachment_folder_of(file_name), `${sanitize_attachment_segment(stem, Math.max(stem_limit, 1))}${suffix}${ext}`)
}

/**
 * How an operation wants a name the scope already holds to be handled:
 * `suffix` is an upload or a fresh name stepping aside with a random suffix,
 * `reject` a rename or a new folder refusing with a 409, and `merge` a folder
 * move landing on the folder that already answers to the name.
 */
type AttachmentNameConflict = 'suffix' | 'reject' | 'merge'

/**
 * The one gate every attachment path passes through, so legality is decided in
 * a single place instead of once per operation. It answers all three questions
 * — illegal characters, the reserved `.good` suffix, and whether the scope
 * already holds the name — built on the shared rules in `content-markdown.ts`
 * so the editor cannot disagree with the server about what is legal.
 *
 * For a name the author supplies: an upload, a rename, a replacement, a folder.
 * A name the server *derives* from a row it already holds goes through
 * `assert_attachment_name_available` instead — see there.
 *
 * The conflict policy is the caller's, because it genuinely differs by
 * operation; everything scope-independent is a 400 the author has to fix.
 * Returns the name to store, which is the given one unless it was suffixed.
 */
export function resolve_attachment_name(
  name: string,
  existing: Iterable<string>,
  on_taken: AttachmentNameConflict,
  ignore_path: string | null = null,
) {
  assert_attachment_name_legal(name)
  if (! attachment_path_taken(existing, name, ignore_path))
    return name
  if (on_taken === 'reject')
    throw new ApiError(409, attachment_name_conflict_message)
  if (on_taken === 'merge')
    return name
  return suffixed_attachment_name(name, extname(attachment_base_name(name)).toLowerCase())
}

/** The scope-independent half: a name no author may type, whichever door it arrives by. */
function assert_attachment_name_legal(name: string) {
  const violation = attachment_path_violation(name)
  if (violation)
    throw new ApiError(400, violation)
}

/**
 * The conflict half, for a name the server derived from a row it already holds:
 * a file following its renamed folder, or a move into another folder.
 *
 * Such a name is legal by construction — and may carry the `.good` marker,
 * which only the encrypt step may append but which the scope already holds — so
 * only its availability is open to question. Sending it through the legality
 * check refused every legitimate move of an encrypted file, which is how a
 * folder holding one became impossible to rename.
 */
function assert_attachment_name_available(name: string, existing: Iterable<string>, ignore_path: string | null = null) {
  if (attachment_path_taken(existing, name, ignore_path))
    throw new ApiError(409, attachment_name_conflict_message)
}

/**
 * A file rename, where only the editable stem is the author's.
 *
 * The `.good` marker is the row's own state, not part of the name being edited
 * (see `split_attachment_editable_name`), so it is checked as state rather than
 * as a name: it may neither appear nor disappear here, since a rename swaps no
 * object and a row whose name and encryption disagreed would render ciphertext
 * as if it were plaintext. 加密/取消加密 are the operations that own that
 * transition. Legality therefore applies to the name with the marker stripped.
 */
function resolve_renamed_attachment_name(old_file_name: string, new_file_name: string, existing: Iterable<string>) {
  // The extension is normalized before the guards: lowering it after the
  // encryption-marker check could flip a legal `a.png.GOOD` into the reserved
  // `.good` marker the check had just cleared. The marker-aware normalizer
  // reaches the plaintext extension underneath an existing `.good`.
  const normalized = normalized_attachment_extension(new_file_name)
  if (is_encrypted_attachment(old_file_name) !== is_encrypted_attachment(normalized))
    throw new ApiError(400, `不能通过重命名增删 ${encrypted_attachment_suffix} 后缀`)
  assert_attachment_name_legal(decrypted_attachment_name(normalized))
  assert_attachment_name_available(normalized, existing, old_file_name)
  return normalized
}

export async function delete_attachment(story_id: number, file_name: string, markdown: string, base_revision: number, can_private: boolean) {
  return await with_attachment_lock(story_id, 'delete', async () => {
    const result = await update_story(story_id, markdown, [file_name], base_revision, can_private)
    if (! result.succeeded.includes(file_name)) {
      throw new ApiError(404, '附件不存在或已被删除')
    }
  })
}

/**
 * Moves an attachment into a folder (or back to root when `target_folder` is
 * null): a row update plus the story's markdown/cover reference rewrite.
 */
export async function move_attachment(story_id: number, file_name: string, target_folder: string | null) {
  return await with_attachment_lock(story_id, 'move', async () => {
    const story = await get_story(story_id)
    const attachments = story.attachments
    const attachment = attachments.find(item => item.file_name === file_name)
    if (! attachment)
      throw new ApiError(404, '附件不存在或已被删除')

    const new_file_name = attachment_path_join(target_folder, attachment_base_name(file_name))
    if (new_file_name === file_name)
      return attachment

    // Only the folder changes, so the name is the row's own — an encrypted
    // file's `.good` marker rides along rather than being re-validated.
    assert_attachment_name_available(new_file_name, await list_scope_paths(story_id))

    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      await rename_attachment_row(story_id, file_name, new_file_name, connection)
      await rewrite_story_attachment_refs(connection, story.id, [{ old_file_name: file_name, new_file_name }])
      await connection.commit()
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally {
      connection.release()
    }

    await publish_attachment_change(story_id)
    const row = await get_scope_attachment(story_id, new_file_name)
    return row ?? { ... attachment, file_name: new_file_name }
  })
}

export interface AttachmentMove {
  file_name: string
  target_folder: string | null
}

/**
 * Moves many attachments in one pass: a single listing fetch, a single
 * markdown/cover rewrite and one refresh — instead of one request per file.
 * Each move keeps its own target folder (or root when null).
 */
export async function move_attachments(story_id: number, moves: AttachmentMove[]): Promise<ContentAttachmentBatchResult> {
  return await with_attachment_lock(story_id, 'move', async () => {
    const story = await get_story(story_id)
    const attachments = story.attachments
    const by_name = new Map(attachments.map(item => [item.file_name, item]))

    const planned: { attachment: ContentStoryAttachment, old_file_name: string, new_file_name: string }[] = []
    const skipped: ContentBatchSkipped[] = []
    for (const move of moves) {
      const attachment = by_name.get(move.file_name)
      if (! attachment) {
        skipped.push({ file_name: move.file_name, reason: '附件不存在或已被删除' })
        continue
      }
      const new_file_name = attachment_path_join(move.target_folder, attachment_base_name(move.file_name))
      if (new_file_name !== move.file_name)
        planned.push({ attachment, old_file_name: move.file_name, new_file_name })
    }

    if (! planned.length) {
      publish_attachment_refresh(story_id)
      return { attachments, succeeded: [], skipped }
    }

    // A destination must not collide with anything that still exists after the
    // batch — files and folders alike — and two moves in the same batch must not
    // land on the same name. The batch's own sources are excluded: a chained
    // move (a→b, b→c) frees the name it vacates.
    const moved_away = new Set(planned.map(plan => plan.old_file_name.toLowerCase()))
    const remaining = (await list_scope_paths(story_id)).filter(path => ! moved_away.has(path.toLowerCase()))
    const destinations = new Set<string>()
    const available: typeof planned = []
    for (const plan of planned) {
      const lower = plan.new_file_name.toLowerCase()
      if (destinations.has(lower)) {
        skipped.push({ file_name: plan.old_file_name, reason: attachment_name_conflict_message })
        continue
      }
      destinations.add(lower)
      // The batch's own sources are already excluded from `remaining`, so the
      // guard sees exactly the names that survive it. Only the folder changes,
      // so the row's own name (and any `.good` marker on it) is not re-validated.
      try {
        assert_attachment_name_available(plan.new_file_name, remaining)
      }
      catch (error) {
        if (error instanceof ApiError && error.statusCode === 409) {
          skipped.push({ file_name: plan.old_file_name, reason: attachment_name_conflict_message })
          continue
        }
        throw error
      }
      available.push(plan)
    }
    planned.splice(0, planned.length, ... available)

    if (! planned.length) {
      publish_attachment_refresh(story_id)
      return { attachments, succeeded: [], skipped }
    }

    // Two-phase rename: a destination may be another move's source (a→b, b→c),
    // and the unique index forbids holding that name even mid-batch. Both loops
    // run on one transaction — a failure between them must restore the original
    // names instead of stranding rows under `.mvtmp-` display paths.
    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      const temp_names = planned.map(() => `.mvtmp-${crypto.randomUUID()}`)
      for (const [index, plan] of planned.entries()) {
        await rename_attachment_row(story_id, plan.old_file_name, temp_names[index]!, connection)
      }
      for (const [index, plan] of planned.entries()) {
        await rename_attachment_row(story_id, temp_names[index]!, plan.new_file_name, connection)
      }
      await rewrite_story_attachment_refs(connection, story.id, planned)
      await connection.commit()
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally {
      connection.release()
    }

    await publish_attachment_change(story_id)
    const result_attachments = (await get_story(story_id)).attachments
    return {
      attachments: result_attachments,
      succeeded: planned.map(plan => plan.old_file_name),
      skipped,
    }
  })
}

export async function rename_attachment(story_id: number, old_file_name: string, new_file_name: string) {
  return await with_attachment_lock(story_id, 'rename', async () => {
    const story = await get_story(story_id)
    const attachments = story.attachments
    const attachment = attachments.find(item => item.file_name === old_file_name)
    if (! attachment) {
      throw new ApiError(404, '附件不存在或已被删除')
    }
    if (old_file_name === new_file_name) {
      return attachment
    }
    // The renamed file is excluded from its own conflict check.
    const file_name = resolve_renamed_attachment_name(old_file_name, new_file_name, await list_scope_paths(story_id))

    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      await rename_attachment_row(story_id, old_file_name, file_name, connection)
      await rewrite_story_attachment_refs(connection, story.id, [{ old_file_name, new_file_name: file_name }])
      await connection.commit()
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally {
      connection.release()
    }

    await publish_attachment_change(story_id)
    const row = await get_scope_attachment(story_id, file_name)
    return row ?? { ... attachment, file_name }
  })
}
