import type { ImageSaveMode } from '@shared/content-upload'
import type { ContentStoryAttachment } from '@shared/types/content'
import { content_image_formats } from '@shared/content-image-format'
import { attachment_redaction_path, split_attachment_editable_name } from '@shared/content-markdown'
import { suggested_image_name } from './image-edit'

interface DialogProps {
  visible: boolean
  attachment: ContentStoryAttachment | null
}

interface DialogOptions {
  /** Source authorization; defaults to the content API. */
  load?: ReturnType<typeof useApi>['content']['image_editor_source']
  confirm: ReturnType<typeof useMyConfirm>['confirm_require']
  save: (file: File, mode: ImageSaveMode, name: string, basis: 'display' | 'original') => void
}

/** Owns source authorization and save intent; bitmap history belongs to useImageEditSession. */
export function useImageEditorDialog(props: Readonly<DialogProps>, options: DialogOptions) {
  const load = options.load ?? useApi().content.image_editor_source
  const mode = ref<ImageSaveMode>('overwrite')
  const input_basis = ref<'display' | 'original'>('display')
  const base_ready = ref(false)
  const output_name = ref('')
  const original_name = computed(() => split_attachment_editable_name(props.attachment?.file_name ?? ''))
  // Only a file named `X.good` has a 删减版: the public file `X` in the same folder.
  const redaction_path = computed(() => attachment_redaction_path(props.attachment?.file_name ?? ''))
  const redaction_name = computed(() => split_attachment_editable_name(redaction_path.value ?? ''))
  const display_name = computed({
    get: () => mode.value === 'copy' ? output_name.value : mode.value === 'redacted' ? redaction_name.value.editable : original_name.value.editable,
    set: (value: string) => {
      if (mode.value === 'copy')
        output_name.value = value
    },
  })
  const name_suffix = computed(() => mode.value === 'copy' ? `.${content_image_formats.display.extension}` : mode.value === 'redacted' ? redaction_name.value.locked : original_name.value.locked)
  const save_name = computed(() => mode.value === 'copy' ? `${output_name.value}.${content_image_formats.display.extension}` : mode.value === 'redacted' ? redaction_path.value ?? '' : props.attachment?.file_name ?? '')
  const save_confirmation = computed(() => mode.value === 'overwrite' ? '将覆盖当前图片的显示版本，确认保存？' : mode.value === 'copy' ? '将另存为新图，确认保存？' : '将另存为删减版，任何人都能看到，确认保存？')
  const source_url = ref<string | null>(null)
  const source_error = ref('')
  const source_loading = ref(false)
  const original_url = ref<string | null>(null)
  const original_reason = ref('正在检查原图')
  const modes = computed(() => [{ label: '另存为', value: 'copy' }, { label: '覆盖', value: 'overwrite' }, ... (redaction_path.value ? [{ label: '作为删减版', value: 'redacted' }] : [])])
  let generation = 0
  let disposed = false

  function reset_output_name() {
    output_name.value = split_attachment_editable_name(suggested_image_name(props.attachment?.file_name ?? 'image')).editable
  }

  watch(() => [props.visible, props.attachment] as const, async ([open, attachment]) => {
    const epoch = ++ generation
    mode.value = 'overwrite'
    input_basis.value = 'display'
    base_ready.value = false
    source_url.value = original_url.value = null
    source_error.value = ''
    source_loading.value = false
    original_reason.value = '正在检查原图'
    reset_output_name()
    if (! open || ! attachment?.id || ! attachment.url)
      return
    source_loading.value = true
    try {
      const version = new URL(attachment.url, window.location.origin).searchParams.get('version')!
      const source = await load(attachment.id, version)
      if (disposed || epoch !== generation)
        return
      source_url.value = source.display_url
      original_url.value = source.original_url
      original_reason.value = source.original_reason
    }
    catch (error) {
      if (! disposed && epoch === generation) {
        source_error.value = error instanceof Error ? error.message : '无法读取图片'
        original_reason.value = source_error.value
      }
    }
    finally {
      if (! disposed && epoch === generation)
        source_loading.value = false
    }
  }, { immediate: true })

  const save_disabled = computed(() => ! source_url.value || (mode.value === 'copy' && ! output_name.value.trim()))
  function save(file: File) {
    if (! disposed && ! save_disabled.value)
      options.save(file, mode.value, save_name.value, input_basis.value)
  }
  function request_reset(event: Event) {
    if (! base_ready.value || ! original_url.value)
      return
    const epoch = generation
    options.confirm(event, '将丢弃未保存的编辑及操作记录，确认回退？', () => {
      if (disposed || ! props.visible || epoch !== generation || ! base_ready.value || ! original_url.value)
        return
      source_url.value = `${original_url.value}&editor_reset=${++ generation}`
      input_basis.value = 'original'
    }, { acceptLabel: '确认回退' })
  }
  onBeforeUnmount(() => {
    disposed = true
    generation ++
  })
  return { mode, input_basis, base_ready, output_name, original_name, display_name, name_suffix, save_name,
    save_confirmation, source_url, source_error, source_loading, original_url, original_reason,
    modes, save, request_reset, save_disabled }
}
