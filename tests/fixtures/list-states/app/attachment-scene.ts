import type { ContentAttachmentWorkspace, ContentStoryAttachment, ContentWorkspaceNode } from '@shared/types/content'
import type { useAttachmentPanel } from '~/features/content/attachments/panel'
import type { WorkspaceListRow } from '~/features/content/attachments/workspace-model'
import { computed, reactive, ref } from 'vue'
import { project_workspace_rows, workspace_capabilities } from '~/features/content/attachments/workspace-model'

type Phase = 'loading' | 'failure' | 'empty' | 'ready'

/** Browser-only fixture: real workspace presentation with no API or upload effects. */
export function create_attachment_scene(retry: () => Promise<void>) {
  const data = ref<ContentAttachmentWorkspace | null>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)
  const selected = ref(new Set<string>())
  const expanded = ref(new Set<number>([2]))
  const access = reactive({ readonly: false })
  const file: ContentStoryAttachment = {
    id: 3, file_name: '示例文件夹/示例文件.txt', mime_type: 'text/plain', file_size: 1024,
    version: 'preview-v1', is_image: false, url: '#preview-file',
  }
  const nodes: ContentWorkspaceNode[] = [
    { id: 2, parent_id: 1, name: '示例文件夹', path: '示例文件夹', kind: 'folder', version: 'preview-v1' },
    { id: 3, parent_id: 2, name: '示例文件.txt', path: file.file_name, kind: 'file', version: 'preview-v1', attachment: file },
  ]
  const empty: ContentAttachmentWorkspace = { nodes: [], root_id: 1, attachments: [], folders: [], namespace_revision: 1, viewer_key: 'preview:false' }
  const populated: ContentAttachmentWorkspace = { ... empty, nodes, attachments: [file], folders: ['示例文件夹'] }
  const rows = computed(() => project_workspace_rows(data.value?.nodes ?? [], [], data.value?.root_id ?? 0, expanded.value))
  const noop = () => {}
  const done = async () => {}
  const uploads = reactive({
    identity_key: 'preview:attachments', preparations: [], sessions: [], reservations: [],
    admitting: false, admission_error: '', resolution: null, privacy_confirmation: null,
    errors: new Map<string, string>(), progress: new Map(), active: new Set<string>(), queued: new Set<string>(),
    pause: noop, resume: async () => true, cancel: done, can_cancel_preparation: () => false, cancel_preparation: noop,
    submit: done, confirm_privacy: done, dismiss_privacy: noop, dismiss_resolution: noop,
  })
  const controller = {
    ready: Promise.resolve(),
    catalog: { data, loading, error, active: true, ready: Promise.resolve({ refresh: retry }), refresh: retry,
      accept(snapshot: ContentAttachmentWorkspace) {
        data.value = snapshot
        error.value = null
      } },
    rows, uploads, selected, expanded,
    selected_rows: computed(() => rows.value.filter(row => selected.value.has(row.key))),
    root_id: computed(() => data.value?.root_id ?? 0),
    get readonly() { return access.readonly },
    set readonly(value: boolean) { access.readonly = value },
    can_private: computed(() => true), drag_ids: ref<number[]>([]),
    preview_visible: ref(false), preview_images: ref<string[]>([]),
    draft_markdown: computed(() => ''), referenced_paths: computed(() => null),
    pending: computed(() => false), resolution: computed(() => null), request_error: computed(() => ''), failure_visible: ref(false),
    resolution_pending: computed(() => false), privacy_confirmation: computed(() => null), privacy_pending: computed(() => false),
    command_pending: () => false, command_moving: () => false, command_failed: () => false, can_execute: () => true,
    capabilities: (row: WorkspaceListRow) => workspace_capabilities(row, { readonly: access.readonly, can_private: true, pending: false }),
    target: (row: WorkspaceListRow) => ({ id: row.node!.id, version: row.node!.version }),
    toggle_folder(row: WorkspaceListRow) {
      if (! row.node)
        return
      const next = new Set(expanded.value)
      if (next.has(row.node.id))
        next.delete(row.node.id)
      else
        next.add(row.node.id)
      expanded.value = next
    },
    get_delete_impact: async () => ({ targets: [], sources: [] }),
    execute: done, submit: done, start: done, replace: done, edit_image: done,
    open: noop, download: done, preview: noop,
    confirm_privacy: done, dismiss_privacy: noop, dismiss_resolution: noop,
  } as unknown as ReturnType<typeof useAttachmentPanel>

  function show(phase: Phase) {
    loading.value = phase === 'loading'
    error.value = phase === 'failure' ? '暂时无法连接附件服务' : null
    data.value = phase === 'ready' ? populated : phase === 'empty' ? empty : null
    selected.value = new Set()
    expanded.value = new Set([2])
  }

  return { controller, show }
}
