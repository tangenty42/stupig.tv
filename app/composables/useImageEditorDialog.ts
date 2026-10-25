import type { ImageSaveMode } from '@shared/content-upload'
import type { ContentStoryAttachment } from '@shared/types/content'
import { split_attachment_editable_name } from '@shared/content-markdown'
import { suggested_image_name } from '~/utils/content/image-edit'

interface DialogProps {
  visible: boolean
  attachment: ContentStoryAttachment | null
  redacted?: boolean
  pending?: boolean
}

interface DialogOptions {
  load: ReturnType<typeof useApi>['content']['image_editor_source']
  confirm: ReturnType<typeof useMyConfirm>['confirm_require']
  save: (file: File, mode: ImageSaveMode, name: string, basis: 'avif' | 'original') => void
}

/** Owns source authorization and save intent; bitmap history belongs to useImageEditSession. */
export function useImageEditorDialog(props: Readonly<DialogProps>, options: DialogOptions) {
  const mode = ref<ImageSaveMode>(props.redacted ? 'redacted' : 'overwrite')
  const input_basis = ref<'avif' | 'original'>('avif')
  const base_ready = ref(false)
  const output_name = ref('')
  const original_name = computed(() => split_attachment_editable_name(props.attachment?.file_name ?? ''))
  const display_name = computed({
    get: () => mode.value === 'copy' ? output_name.value : original_name.value.editable,
    set: (value: string) => {
      if (mode.value === 'copy')
        output_name.value = value
    },
  })
  const save_name = computed(() => mode.value === 'copy' ? `${output_name.value}.avif` : props.attachment?.file_name ?? '')
  const save_confirmation = computed(() => mode.value === 'overwrite' ? '将覆盖原图，确认保存？' : mode.value === 'copy' ? '将另存为新图，确认保存？' : '将另存为删减版，确认保存？')
  const source_url = ref<string | null>(null)
  const source_error = ref('')
  const source_loading = ref(false)
  const original_url = ref<string | null>(null)
  const original_reason = ref('正在检查原图')
  const modes = [{ label: '另存为', value: 'copy' }, { label: '覆盖', value: 'overwrite' }]
  let generation = 0
  let name_mode: ImageSaveMode = 'copy'
  let disposed = false

  function reset_output_name() {
    name_mode = mode.value
    const name = suggested_image_name(props.attachment?.file_name ?? 'image', mode.value === 'redacted' ? 'redacted' : 'copy')
    output_name.value = split_attachment_editable_name(name).editable
  }

  watch(mode, () => {
    if (mode.value !== 'overwrite' && mode.value !== name_mode)
      reset_output_name()
  })
  watch(() => [props.visible, props.attachment, props.redacted] as const, async ([open, attachment]) => {
    const epoch = ++ generation
    mode.value = props.redacted ? 'redacted' : 'overwrite'
    input_basis.value = 'avif'
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
      const source = await options.load(attachment.id, version, Boolean(props.redacted))
      if (disposed || epoch !== generation)
        return
      source_url.value = source.avif_url
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

  function save(file: File) {
    if (! disposed && (mode.value === 'overwrite' || output_name.value.trim()))
      options.save(file, mode.value, save_name.value, input_basis.value)
  }
  function request_reset(event: Event) {
    if (! base_ready.value || ! original_url.value || props.pending)
      return
    const epoch = generation
    options.confirm(event, '将丢弃未保存的编辑及操作记录，确认回退？', () => {
      if (disposed || ! props.visible || epoch !== generation || props.pending || ! base_ready.value || ! original_url.value)
        return
      source_url.value = `${original_url.value}&editor_reset=${++ generation}`
      input_basis.value = 'original'
    }, { acceptLabel: '确认回退' })
  }
  onBeforeUnmount(() => {
    disposed = true
    generation ++
  })
  const save_disabled = computed(() => ! source_url.value || (mode.value !== 'overwrite' && ! output_name.value.trim()))
  return { mode, input_basis, base_ready, output_name, original_name, display_name, save_name,
    save_confirmation, source_url, source_error, source_loading, original_url, original_reason,
    modes, save, request_reset, save_disabled }
}
