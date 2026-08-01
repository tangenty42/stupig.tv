<template>
  <div>
    <input ref="file_input" type="file" class="hidden" accept="image/png,image/jpeg,image/webp" @change="on_select_file">

    <MyDialog
      v-model:visible="crop_modal_visible"
      header="调整头像"
      :pending="pending"
      @update:visible="() => { if (! crop_modal_visible) { close_crop_modal() } }"
    >
      <div class="overflow-hidden">
        <img ref="crop_image" :src="source_url" alt="待裁剪头像" class="block max-h-[60vh] w-full select-none">
      </div>

      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <Button aria-label="向左旋转" rounded severity="secondary" :disabled="pending" @click="rotate_left">
              <template #icon>
                <MyIcon name="lucide:rotate-ccw" />
              </template>
            </Button>
            <Button aria-label="向右旋转" rounded severity="secondary" :disabled="pending" @click="rotate_right">
              <template #icon>
                <MyIcon name="lucide:rotate-cw" />
              </template>
            </Button>
          </div>
          <div class="flex items-center gap-2">
            <Button label="取消" severity="secondary" text rounded :disabled="pending" @click="close_crop_modal" />
            <Button rounded label="确定" :loading="pending" :disabled="pending" @click="submit_avatar">
              <template #icon>
                <MyIcon name="lucide:check" />
              </template>
            </Button>
          </div>
        </div>
      </template>
    </MyDialog>
  </div>
</template>

<script setup lang="ts">
import Cropper from 'cropperjs'
import 'cropperjs/dist/cropper.css'

const props = withDefaults(defineProps<{
  targetId?: number | null
}>(), {
  targetId: null,
})

const emit = defineEmits<{
  updated: []
}>()

const { profile: profile_api } = useApi()
const { error, ok } = useMyToast()

const file_input = ref<HTMLInputElement | null>(null)
const crop_image = ref<HTMLImageElement | null>(null)
const cropper = ref<Cropper | null>(null)

const crop_modal_visible = ref(false)
const source_url = ref('')
const pending = ref(false)

function open_picker() {
  file_input.value?.click()
}

defineExpose({
  open_picker,
  pending,
})

function clear_cropper() {
  if (cropper.value) {
    cropper.value.destroy()
    cropper.value = null
  }
}

function clear_source() {
  if (source_url.value) {
    URL.revokeObjectURL(source_url.value)
    source_url.value = ''
  }
}

function reset_file_input() {
  if (file_input.value) {
    file_input.value.value = ''
  }
}

function rotate_left() {
  cropper.value?.rotate(- 90)
}

function rotate_right() {
  cropper.value?.rotate(90)
}

function close_crop_modal() {
  crop_modal_visible.value = false
  clear_cropper()
  clear_source()
  reset_file_input()
}

watch(crop_modal_visible, (visible) => {
  if (! visible) {
    close_crop_modal()
  }
})

function init_cropper() {
  if (! crop_image.value) {
    return
  }

  clear_cropper()

  cropper.value = new Cropper(crop_image.value, {
    aspectRatio: 1,
    viewMode: 1,
    dragMode: 'move',
    guides: false,
    center: false,
    highlight: false,
    background: true,
    autoCropArea: 1,
    movable: true,
    zoomable: true,
    scalable: false,
    rotatable: true,
    cropBoxResizable: false,
    cropBoxMovable: false,
    toggleDragModeOnDblclick: false,
  })
}

async function on_select_file(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const config = useRuntimeConfig().public

  if (! file) {
    return
  }

  const max_size_bytes = config.max_avatar_size_mb * 1024 * 1024
  if (file.size > max_size_bytes) {
    error(`文件不能超过 ${format_bytes(max_size_bytes)}`)
    reset_file_input()
    return
  }

  if (! ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    error('只支持 JPG / PNG / WebP')
    reset_file_input()
    return
  }

  clear_source()
  source_url.value = URL.createObjectURL(file)
  crop_modal_visible.value = true

  await nextTick()
  init_cropper()
}

async function submit_avatar() {
  if (! cropper.value) {
    error('请先选择头像文件')
    return
  }

  pending.value = true

  try {
    const canvas = cropper.value.getCroppedCanvas({
      width: 512,
      height: 512,
      fillColor: '#ffffff',
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
    })

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (! result) {
          reject(new Error('头像导出失败'))
          return
        }

        resolve(result)
      }, 'image/jpeg', 0.92)
    })

    await profile_api.upload_avatar(
      new File([blob], `avatar_${Date.now()}.jpg`, { type: 'image/jpeg' }),
      props.targetId,
    )

    emit('updated')
    close_crop_modal()
    ok('头像更换成功')
  }
  catch (ex) {
    error(ex)
  }
  finally {
    pending.value = false
  }
}

onBeforeUnmount(() => {
  clear_cropper()
  clear_source()
})
</script>

<style scoped>
  :deep(.cropper-view-box) {
    border-radius: 100%;
    outline: 0;
    box-shadow: 0 0 0 100vh rgba(0, 0, 0, .3);
  }

  :deep(.cropper-face) {
    border-radius: 100%;
  }
</style>
