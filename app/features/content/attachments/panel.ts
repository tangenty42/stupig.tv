import type { ImageSaveMode } from '@shared/content-upload'
import type { ErrorPolicy, PrivacyConfirmation, WorkspaceCommand, WorkspaceIssue } from '@shared/content-workspace'
import type { ContentStoryAttachment } from '@shared/types/content'
import type { UploadEntry } from '../uploads/admission'
import type { WorkspaceAction, WorkspaceCommandFootprint, WorkspaceListRow } from './workspace-model'
import { attachment_folder_of, attachment_has_private_suffix, attachment_path_join, attachment_redaction_path, normalized_attachment_extension, private_attachment_suffix, referenced_attachment_keys, split_attachment_editable_name } from '@shared/content-markdown'
import { apply_resolution_choices, error_policy_schema } from '@shared/content-workspace'
import { has_permission } from '@shared/permissions'
import { is_client_error } from '~/composables/useApi'
import { attachment_is_media, attachment_is_restricted } from '~/features/content/attachments/rules'
import { useContentUploadsStore } from '../uploads/store'
import { useContentUploadSync } from '../uploads/sync'
import { create_upload_completion_context } from './completion'
import { private_attachment_open_denied_message } from './presentation'
import { createAttachmentWorkspace } from './workspace'
import { project_workspace_commands, project_workspace_rows, workspace_capabilities, workspace_command_footprint, workspace_deepest_folder_id, workspace_footprints_overlap, workspace_row_footprint } from './workspace-model'

export interface AttachmentPanelInteraction {
  open_url: (url: string) => void
  save_url: (url: string, name?: string) => void
}

interface AttachmentPanelOptions {
  scope: number
  markdown: () => string
  reference_source?: () => { markdown: string, cover?: string | null } | null
  interaction: AttachmentPanelInteraction
  readonly?: boolean
  on_landed?: (file: ContentStoryAttachment) => void
}

/** One editing-context controller can feed both editor and page attachment panels. */
export function useAttachmentPanel(options: AttachmentPanelOptions) {
  const { scope, markdown, interaction, readonly = false, on_landed } = options
  const { content } = useApi()
  const { user } = useAuth()
  const toast = useMyToast()
  const uploads = useContentUploadsStore(scope)
  const catalog = createAttachmentWorkspace(scope)
  const sync_pending = ! readonly && scope > 0 ? useContentUploadSync(scope) : Promise.resolve()
  const selected = ref(new Set<string>())
  const expanded = ref(new Set<number>())
  const drag_ids = ref<number[]>([])
  const preview_visible = ref(false)
  const preview_images = ref<string[]>([])
  interface Operation {
    command: WorkspaceCommand
    footprint: WorkspaceCommandFootprint
    pending: boolean
    error: string
    resolution: { items: WorkspaceIssue[], valid_count: number } | null
    privacy: PrivacyConfirmation | null
    selection: Set<string>
  }
  const operations = ref<Operation[]>([])
  const pending = computed(() => operations.value.some(operation => operation.pending))
  const resolution_operation = computed(() => operations.value.find(operation => operation.resolution))
  const resolution = computed(() => resolution_operation.value?.resolution ?? null)
  const resolution_pending = computed(() => resolution_operation.value?.pending ?? false)
  const privacy_operation = computed(() => operations.value.find(operation => operation.privacy))
  const privacy_confirmation = computed(() => privacy_operation.value?.privacy ?? null)
  const privacy_pending = computed(() => privacy_operation.value?.pending ?? false)
  const request_error = computed(() => operations.value.find(operation => operation.error)?.error ?? '')
  const failure_visible = ref(false)
  watch([request_error, () => uploads.admission_error, pending, () => uploads.admitting], ([request, admission, working, admitting], previous) => {
    if ((request && request !== previous?.[0]) || (admission && admission !== previous?.[1]))
      failure_visible.value = true
    else if (! request && ! admission && ! working && ! admitting)
      failure_visible.value = false
  }, { immediate: true, flush: 'sync' })
  const completion = create_upload_completion_context()
  let generation = 0
  const projected_nodes = computed(() => project_workspace_commands(catalog.data.value?.nodes ?? [], operations.value.filter(operation => operation.pending || operation.error).map(operation => operation.command)))
  const rows = computed(() => project_workspace_rows(projected_nodes.value, readonly ? [] : uploads.sessions, catalog.data.value?.root_id ?? 0, expanded.value, readonly ? [] : uploads.preparations))
  watch(() => uploads.preparations.map(item => ({ key: `preparing:${item.id}`, replacing: item.purpose === 'replace' || item.purpose === 'redact' ? item.source_id : item.replacement_id })), (next, previous) => {
    const removed = new Set(previous.filter(item => ! next.some(current => current.key === item.key)).map(item => item.key))
    const hidden = new Set(next.filter(item => item.replacing).map(item => `node:${item.replacing}`))
    for (const key of removed)
      hidden.add(key)
    if ([... selected.value].some(key => hidden.has(key)))
      selected.value = new Set([... selected.value].filter(key => ! hidden.has(key)))
  }, { flush: 'sync' })
  const upload_expansion_ids = computed(() => {
    if (readonly)
      return []
    const nodes = catalog.data.value?.nodes ?? []
    const folder = (id: number | undefined) => nodes.find(node => node.kind === 'folder' && node.id === id)
    const ids = new Set<number>()
    const expand_chain = (id: number | undefined) => {
      let current = folder(id)
      while (current) {
        ids.add(current.id)
        current = folder(current.parent_id)
      }
    }
    for (const preparation of uploads.preparations)
      expand_chain(workspace_deepest_folder_id(preparation.path, nodes))
    for (const session of uploads.sessions) {
      // Unsynced target folders are synthesized in the projection; expanding
      // the deepest existing ancestor keeps the pending rows reachable.
      expand_chain(folder(session.parent_id) ? session.parent_id : workspace_deepest_folder_id(session.path, nodes))
    }
    return [... ids]
  })
  watch(upload_expansion_ids, (ids) => {
    const next = new Set(expanded.value)
    for (const id of ids)
      next.add(id)
    if (next.size !== expanded.value.size)
      expanded.value = next
  }, { immediate: true, flush: 'sync' })
  watch(() => uploads.sessions.map(session => ({ key: `session:${session.id}`, replacing: session.purpose === 'replace' || session.purpose === 'redact' ? session.source_id : session.replacement_id })), (next, previous) => {
    const hidden = new Set(next.filter(item => item.replacing).map(item => `node:${item.replacing}`))
    for (const task of previous) {
      if (! next.some(item => item.key === task.key))
        hidden.add(task.key)
    }
    // File and task selections never inherit one another, including cancellation.
    if ([... selected.value].some(key => hidden.has(key)))
      selected.value = new Set([... selected.value].filter(key => ! hidden.has(key)))
  }, { flush: 'sync' })
  const root_id = computed(() => catalog.data.value?.root_id ?? 0)
  const can_private = computed(() => has_permission(user.value, 'content_access', 'private_read'))
  const draft_markdown = computed(markdown)
  const referenced_paths = computed(() => {
    const source = options.reference_source?.()
    const workspace = catalog.data.value
    return source && workspace ? referenced_attachment_keys(source.markdown, workspace.attachments, workspace.folders, source.cover) : null
  })
  const get_delete_impact = (targets: number[]) => content.get_delete_impact({ kind: 'attachment', id: scope, targets })
  const affected_operation = (row: WorkspaceListRow) => operations.value.find(operation => workspace_footprints_overlap(operation.footprint, workspace_row_footprint(row)))
  const command_failed = (row: WorkspaceListRow) => !! affected_operation(row)?.error
  const command_pending = (row: WorkspaceListRow) => operations.value.some(operation => operation.pending && workspace_footprints_overlap(operation.footprint, workspace_row_footprint(row)))
  const command_moving = (row: WorkspaceListRow) => operations.value.some(operation => operation.pending && operation.command.operation === 'move' && row.node && operation.footprint.ids.includes(row.node.id))
  const capabilities = (row: WorkspaceListRow) => {
    const operation = affected_operation(row)
    return workspace_capabilities(row, { readonly, can_private: can_private.value, pending: !! operation, pending_reason: operation?.pending ? '正在提交操作' : '此项操作结果待处理', nodes: catalog.data.value?.nodes, reservations: uploads.reservations })
  }
  function toggle_folder(row: WorkspaceListRow) {
    if (row.node?.kind !== 'folder')
      return
    const next = new Set(expanded.value)
    if (next.has(row.node.id))
      next.delete(row.node.id)
    else
      next.add(row.node.id)
    expanded.value = next
  }
  const selected_rows = computed(() => rows.value.filter(row => selected.value.has(row.key)))
  const target = (row: WorkspaceListRow) => ({ id: row.node!.id, version: row.node!.version })
  async function submit_operation(operation: Operation, policy?: ErrorPolicy) {
    if (operation.pending)
      return
    if (policy && operation.resolution)
      operation.command = { ... operation.command, request_id: crypto.randomUUID(), on_error: apply_resolution_choices(operation.command.on_error, operation.resolution.items, policy) }
    operation.pending = true
    const epoch = generation
    operation.error = ''
    try {
      const result = await content.execute_workspace_command(operation.command)
      if (epoch !== generation)
        return
      catalog.accept(result.workspace)
      const inherited = result.still_inherited_private?.length ?? 0
      if (inherited)
        toast.info(`已移除自身机密标记，${inherited} 项仍因上级文件夹保持机密`)
      operations.value = operations.value.filter(item => item !== operation)
      selected.value = new Set([... selected.value].filter(key => ! operation.selection.has(key)))
    }
    catch (error) {
      if (epoch !== generation)
        return
      const value = error as { code?: string, details?: unknown }
      if (value.code === 'BATCH_REJECTED' && value.details && typeof value.details === 'object' && 'valid_count' in value.details) {
        operation.resolution = value.details as { items: WorkspaceIssue[], valid_count: number }
        operation.privacy = null
      }
      else if (value.code === 'PRIVACY_CONFIRMATION' && value.details) {
        operation.privacy = value.details as PrivacyConfirmation
        operation.resolution = null
      }
      else {
        operation.resolution = null
        operation.privacy = null
        if (is_client_error(error)) {
          operations.value = operations.value.filter(item => item !== operation)
          toast.error(error instanceof Error ? error.message : '附件操作失败')
        }
        else {
          // An old rejection cannot authorize a new command after this submission
          // may have committed. Only retry its existing receipt until reconciled.
          operation.error = '附件操作结果待确认'
          failure_visible.value = true
        }
      }
    }
    finally {
      if (epoch === generation)
        operation.pending = false
    }
  }
  function submit(policy?: ErrorPolicy) {
    const operation = policy ? resolution_operation.value : operations.value.find(item => item.error)
    if (operation)
      return submit_operation(operation, policy)
  }
  const can_execute = (input: WorkspaceAction) => ! operations.value.some(operation => workspace_footprints_overlap(operation.footprint, workspace_command_footprint(input, catalog.data.value?.nodes ?? [])))
  function execute(input: WorkspaceAction) {
    const command = { ... input, request_id: crypto.randomUUID(), scope_id: scope, on_error: error_policy_schema.parse({ by_item: {} }) } as WorkspaceCommand
    const footprint = workspace_command_footprint(command, catalog.data.value?.nodes ?? [])
    const blocked = operations.value.find(operation => workspace_footprints_overlap(operation.footprint, footprint))
    if (blocked) {
      if (blocked.error)
        failure_visible.value = true
      else
        toast.error('此目标仍有操作待完成，请先处理其结果')
      return
    }
    operations.value.push({ command, footprint, pending: false, error: '', resolution: null, privacy: null, selection: new Set([... selected.value].filter(key => footprint.ids.some(id => key === `node:${id}`))) })
    return submit_operation(operations.value[operations.value.length - 1]!)
  }
  function dismiss_resolution() {
    const operation = resolution_operation.value
    if (operation && ! operation.pending)
      operations.value = operations.value.filter(item => item !== operation)
  }
  /** 「继续」 approves exactly the listed effects; different effects ask again. */
  function confirm_privacy() {
    const operation = privacy_operation.value
    if (! operation || operation.pending)
      return
    operation.command = { ... operation.command, request_id: crypto.randomUUID(), privacy_digest: operation.privacy!.digest }
    operation.privacy = null
    return submit_operation(operation)
  }
  function dismiss_privacy() {
    const operation = privacy_operation.value
    if (operation && ! operation.pending)
      operations.value = operations.value.filter(item => item !== operation)
  }
  async function start(entries: UploadEntry[]) {
    const footprint = { ids: entries.flatMap(entry => [entry.source?.id, entry.replacement?.id].filter((id): id is number => id !== undefined)), paths: entries.map(entry => ({ path: normalized_attachment_extension(entry.file_name) + (entry.access === 'private' ? '.good' : ''), subtree: false })) }
    const blocked = operations.value.find(operation => workspace_footprints_overlap(operation.footprint, footprint))
    if (blocked) {
      if (blocked.error)
        failure_visible.value = true
      else
        toast.error('上传目标仍有操作待完成，请先处理其结果')
      return
    }
    const epoch = generation
    try {
      await uploads.start(entries.map(entry => ({ ... entry, on_landed: completion.bind((file) => {
        entry.on_landed?.(file)
        if (! entry.source)
          on_landed?.(file)
      }) })))
    }
    catch (error) {
      if (epoch === generation) {
        if (uploads.admission_error)
          failure_visible.value = true
        else
          toast.error(error instanceof Error ? error.message : '无法开始上传')
      }
    }
  }
  async function download(row: WorkspaceListRow, role: 'display' | 'original' | 'redacted_display' = 'display') {
    const file = row.node?.attachment
    if (! file || (role === 'redacted_display' ? ! file.has_redacted : ! capabilities(row).download))
      return
    try {
      interaction.save_url((await content.sign_attachment_download(scope, row.path, role)).url)
    }
    catch (error) {
      toast.error(error instanceof Error ? error.message : '无法下载')
    }
  }
  function preview(row: WorkspaceListRow, role: 'display' | 'redacted_display' = 'display') {
    const file = row.node?.attachment
    const cap = capabilities(row)
    if (! file || (role === 'redacted_display' ? ! cap.preview_redacted : ! cap.preview))
      return
    const redacted = role === 'redacted_display'
    const url = redacted ? file.redacted_url! : file.url!
    preview_images.value = [url]
    preview_visible.value = true
  }
  function open(row: WorkspaceListRow) {
    if (row.node?.kind === 'folder')
      return toggle_folder(row)
    const file = row.node?.attachment
    if (! file)
      return
    const cap = capabilities(row)
    if (file.is_image ? ! cap.preview && ! cap.preview_redacted : ! cap.open) {
      const denied = attachment_is_restricted(file) && ! can_private.value
      toast.info(denied ? private_attachment_open_denied_message : '附件暂不可读取')
      return
    }
    if (file.is_image) {
      preview(row, cap.preview ? 'display' : 'redacted_display')
    }
    else if (attachment_is_media(file)) {
      interaction.open_url(file.url!)
    }
    else {
      void download(row)
    }
  }
  function replace(row: WorkspaceListRow, file: File, keep_name: boolean) {
    const folder = attachment_folder_of(row.path)
    const marker = attachment_has_private_suffix(row.path) && ! attachment_has_private_suffix(file.name) ? private_attachment_suffix : ''
    const name = keep_name
      ? split_attachment_editable_name(row.path).editable + split_attachment_editable_name(file.name).locked + marker
      : file.name
    const path = normalized_attachment_extension(attachment_path_join(folder, name))
    return start([{ file, file_name: path, purpose: 'replace', source: target(row) }])
  }
  function edit_image(row: WorkspaceListRow, file: File, mode: ImageSaveMode, name: string, basis: 'display' | 'original') {
    // A 删减版 is a public copy named after its private source (`X.good` → `X`).
    const copy = mode !== 'overwrite'
    const path = mode === 'copy' ? attachment_path_join(attachment_folder_of(row.path), name) : mode === 'redacted' ? attachment_redaction_path(row.path) ?? row.path : row.path
    return start([{ file, file_name: path, purpose: copy ? 'create' : 'replace', source: target(row), image_mode: copy ? 'copy' : 'overwrite',
      image_input_basis: basis, save_as_redaction: mode === 'redacted' ? true : undefined }])
  }
  watch(() => uploads.identity_key, () => {
    generation ++
    completion.reset()
    selected.value = new Set()
    operations.value = []
    failure_visible.value = false
    preview_visible.value = false
  }, { flush: 'sync' })
  onUnmounted(() => {
    completion.dispose()
    generation ++
    operations.value = []
  })
  const ready = Promise.all([catalog.ready, sync_pending]).then(() => undefined)
  return { ready, catalog, uploads, selected, selected_rows, expanded, drag_ids, preview_visible, preview_images, rows, root_id, readonly, can_private, draft_markdown, referenced_paths, get_delete_impact, pending, resolution, request_error, failure_visible,
    resolution_pending, privacy_confirmation, privacy_pending, confirm_privacy, dismiss_privacy, command_failed, command_pending, command_moving, can_execute, target, capabilities, toggle_folder, submit, execute, dismiss_resolution, start, open, preview, download, replace, edit_image }
}
