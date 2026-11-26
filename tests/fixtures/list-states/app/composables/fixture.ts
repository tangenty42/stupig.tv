export function useApi() {
  async function image_editor_source() {
    throw new Error('此预览页只演示列表状态')
  }
  return { content: { image_editor_source } }
}

export function useMyToast() {
  return { error: (_error: unknown) => {}, info: (_message: string) => {} }
}

export function useMyConfirm() {
  return { confirm_require: () => {} }
}

export function useStaticUrl() {
  return (path: string) => path
}

export function useDisplayTimeContext() {
  return { timezone: 'Asia/Shanghai' }
}
