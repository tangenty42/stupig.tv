import type { ImageSaveMode } from '@shared/content-upload'
import type { ErrorPolicy, WorkspaceCommand, WorkspaceIssue, WorkspaceReport } from '@shared/content-workspace'
import type { ContentStoryAttachment } from '@shared/types/content'
import type { UploadEntry } from '~/stores/contentUploads'
import type { WorkspaceAction, WorkspaceCommandFootprint, WorkspaceListRow } from '~/utils/content/workspace'
import { attachment_folder_of, attachment_path_join, decrypted_attachment_name, extract_attachment_names, normalized_attachment_extension, split_attachment_editable_name } from '@shared/content-markdown'
import { error_policy_schema } from '@shared/content-workspace'
import { has_permission } from '@shared/permissions'
import { useContentUploadsStore } from '~/stores/contentUploads'
import { attachment_is_media, save_url_as } from '~/utils/content/attachment'
import { select_attachment_row } from '~/utils/content/attachment-list'
import { create_upload_completion_context } from '~/utils/content/upload-completion'
import { project_workspace_rows, workspace_capabilities, workspace_command_footprint, workspace_footprints_overlap, workspace_row_footprint } from '~/utils/content/workspace'

/** One editing-context controller can feed both editor and page attachment panels. */
export async function useAttachmentPanel(scope: number, markdown: () => string, readonly = false, on_landed?: (file: ContentStoryAttachment) => void) {
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
    selection: Set<string>
  }
  const operations = ref<Operation[]>([])
  const reports = ref<WorkspaceReport[]>([])
  const pending = computed(() => operations.value.some(operation => operation.pending))
  const resolution_operation = computed(() => operations.value.find(operation => operation.resolution))
  const resolution = computed(() => resolution_operation.value?.resolution ?? null)
  const resolution_pending = computed(() => resolution_operation.value?.pending ?? false)
  const request_error = computed(() => operations.value.find(operation => operation.error)?.error ?? '')
  const report = computed({ get: () => reports.value[0] ?? null, set: (value: WorkspaceReport | null) => {
    if (! value)
      reports.value.shift()
  } })
  const completion = create_upload_completion_context()
  let generation = 0
  let anchor: string | null = null
  const rows = computed(() => project_workspace_rows(catalog.data.value?.nodes ?? [], readonly ? [] : uploads.sessions, catalog.data.value?.root_id ?? 0, expanded.value))
  watch(() => uploads.sessions.map(session => ({ key: `session:${session.id}`, replacing: session.purpose === 'replace' || session.purpose === 'redact' ? session.source_id : session.replacement_id })), (next, previous) => {
    const hidden = new Set(next.filter(item => item.replacing).map(item => `node:${item.replacing}`))
    for (const task of previous) {
      if (! next.some(item => item.key === task.key))
        hidden.add(task.key)
    }
    // File and task selections never inherit one another, including cancellation.
    if ([... selected.value].some(key => hidden.has(key)))
      selected.value = new Set([... selected.value].filter(key => ! hidden.has(key)))
    if (anchor && hidden.has(anchor))
      anchor = null
  }, { flush: 'sync' })
  const root_id = computed(() => catalog.data.value?.root_id ?? 0)
  const can_private = computed(() => has_permission(user.value, 'content_private', 'read'))
  const references = computed(() => extract_attachment_names(markdown()))
  const affected_operation = (row: WorkspaceListRow) => operations.value.find(operation => workspace_footprints_overlap(operation.footprint, workspace_row_footprint(row)))
  const command_pending = (row: WorkspaceListRow) => operations.value.some(operation => operation.pending && workspace_footprints_overlap(operation.footprint, workspace_row_footprint(row)))
  const command_moving = (row: WorkspaceListRow) => operations.value.some(operation => operation.pending && operation.command.operation === 'move' && row.node && operation.footprint.ids.includes(row.node.id))
  const capabilities = (row: WorkspaceListRow) => {
    const operation = affected_operation(row)
    return workspace_capabilities(row, { readonly, can_private: can_private.value, pending: !! operation, pending_reason: operation?.pending ? '正在提交操作' : '此项操作结果待处理', references: references.value, nodes: catalog.data.value?.nodes, reservations: uploads.reservations })
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
  function select(row: WorkspaceListRow, event: MouseEvent) {
    selected.value = select_attachment_row(rows.value, selected.value, anchor, row, event)
    anchor = row.key
  }
  const selected_rows = computed(() => rows.value.filter(row => selected.value.has(row.key)))
  function clear_selection_outside(event: PointerEvent) {
    const element = event.target as HTMLElement | null
    if (element && ! element.closest('.file-row, .folder-row, .p-contextmenu, .p-menu, .p-dialog, .p-confirmpopup')) {
      selected.value = new Set()
      anchor = null
    }
  }
  onMounted(() => document.addEventListener('pointerdown', clear_selection_outside))
  const target = (row: WorkspaceListRow) => ({ id: row.node!.id, version: row.node!.version })
  async function submit_operation(operation: Operation, policy?: ErrorPolicy) {
    if (operation.pending)
      return
    if (policy)
      operation.command = { ... operation.command, request_id: crypto.randomUUID(), on_error: policy }
    operation.pending = true
    const epoch = generation
    operation.error = ''
    try {
      const result = await content.execute_workspace_command(operation.command)
      if (epoch !== generation)
        return
      if (result.skipped.length || result.renamed.length)
        reports.value.push(result)
      operations.value = operations.value.filter(item => item !== operation)
      selected.value = new Set([... selected.value].filter(key => ! operation.selection.has(key)))
    }
    catch (error) {
      if (epoch !== generation)
        return
      const value = error as { code?: string, details?: { items: WorkspaceIssue[], valid_count: number } }
      if (value.code === 'BATCH_REJECTED' && value.details && 'valid_count' in value.details) {
        operation.resolution = value.details
      }
      else {
        // An old rejection cannot authorize a new command after this submission
        // may have committed. Only retry its existing receipt until reconciled.
        operation.resolution = null
        operation.error = error instanceof Error ? error.message : '操作结果未知，请重试'
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
    const command = { ... input, request_id: crypto.randomUUID(), scope_id: scope, on_error: error_policy_schema.parse({}) } as WorkspaceCommand
    const footprint = workspace_command_footprint(command, catalog.data.value?.nodes ?? [])
    if (operations.value.some(operation => workspace_footprints_overlap(operation.footprint, footprint)))
      return toast.error('此目标仍有操作待完成，请先处理其结果')
    operations.value.push({ command, footprint, pending: false, error: '', resolution: null, selection: new Set([... selected.value].filter(key => footprint.ids.some(id => key === `node:${id}`))) })
    return submit_operation(operations.value[operations.value.length - 1]!)
  }
  function dismiss_resolution() {
    const operation = resolution_operation.value
    if (operation && ! operation.pending)
      operations.value = operations.value.filter(item => item !== operation)
  }
  async function start(entries: UploadEntry[]) {
    const footprint = { ids: entries.flatMap(entry => [entry.source?.id, entry.replacement?.id].filter((id): id is number => id !== undefined)), paths: entries.map(entry => ({ path: normalized_attachment_extension(entry.file_name) + (entry.access === 'private' ? '.good' : ''), subtree: false })) }
    if (operations.value.some(operation => workspace_footprints_overlap(operation.footprint, footprint)))
      return toast.error('上传目标仍有操作待完成，请先处理其结果')
    const epoch = generation
    try {
      await uploads.start(entries.map(entry => ({ ... entry, on_landed: completion.bind((file) => {
        entry.on_landed?.(file)
        if (! entry.source)
          on_landed?.(file)
      }) })))
    }
    catch (error) {
      if (epoch === generation)
        toast.error(error instanceof Error ? error.message : '无法开始上传')
    }
  }
  async function download(row: WorkspaceListRow, role: 'avif' | 'original' | 'redacted_avif' = 'avif') {
    const file = row.node?.attachment
    if (! file || (role === 'redacted_avif' ? ! file.has_redacted : ! capabilities(row).download))
      return
    try {
      save_url_as((await content.sign_attachment_download(scope, row.path, role)).url)
    }
    catch (error) {
      toast.error(error instanceof Error ? error.message : '无法下载')
    }
  }
  function preview(row: WorkspaceListRow, role: 'avif' | 'redacted_avif' = 'avif') {
    const file = row.node?.attachment
    const cap = capabilities(row)
    if (! file || (role === 'redacted_avif' ? ! cap.preview_redacted : ! cap.preview))
      return
    preview_images.value = [role === 'redacted_avif' ? file.redacted_url! : file.url!]
    preview_visible.value = true
  }
  function open(row: WorkspaceListRow) {
    if (row.node?.kind === 'folder')
      return toggle_folder(row)
    const file = row.node?.attachment
    if (! file)
      return
    if (file.is_image)
      return preview(row, capabilities(row).preview ? 'avif' : 'redacted_avif')
    if (! capabilities(row).open)
      return
    if (attachment_is_media(file)) {
      window.open(file.url!, '_blank', 'noopener,noreferrer')
    }
    else {
      void download(row)
    }
  }
  function replace(row: WorkspaceListRow, file: File, keep_name: boolean) {
    const folder = attachment_folder_of(row.path)
    const name = keep_name
      ? split_attachment_editable_name(row.path).editable + split_attachment_editable_name(file.name).locked
      : file.name
    const path = normalized_attachment_extension(attachment_path_join(folder, name))
    return start([{ file, file_name: path, purpose: 'replace', source: target(row) }])
  }
  function edit_image(row: WorkspaceListRow, file: File, mode: ImageSaveMode, name: string, basis: 'avif' | 'original') {
    const folder = attachment_folder_of(row.path)
    const path = mode !== 'copy' ? decrypted_attachment_name(row.path) : `${folder ? `${folder}/` : ''}${name}`
    return start([{ file, file_name: path, purpose: ({ copy: 'create', overwrite: 'replace', redacted: 'redact' } as const)[mode], source: target(row), image_mode: mode, image_input_basis: basis }])
  }
  watch(() => uploads.identity_key, () => {
    generation ++
    completion.reset()
    selected.value = new Set()
    operations.value = []
    reports.value = []
    preview_visible.value = false
  }, { flush: 'sync' })
  onUnmounted(() => {
    document.removeEventListener('pointerdown', clear_selection_outside)
    completion.dispose()
    generation ++
    operations.value = []
    reports.value = []
  })
  await Promise.all([catalog.ready, sync_pending])
  return { catalog, uploads, selected, selected_rows, expanded, drag_ids, preview_visible, preview_images, rows, root_id, readonly, can_private, references, pending, resolution, report, request_error,
    resolution_pending, command_pending, command_moving, can_execute, target, capabilities, toggle_folder, select, submit, execute, dismiss_resolution, start, open, preview, download, replace, edit_image }
}
