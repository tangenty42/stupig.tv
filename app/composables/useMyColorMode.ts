export function useMyColorMode() {
  const my_color_mode = useState<'light' | 'dark' | null>('my-color-mode', () => null)
  const real_color_mode = useColorMode()
  const config = useRuntimeConfig().public
  const cookie_name = config.color_mode_cookie_name
  const fallback = config.color_mode_fallback as 'light' | 'dark'

  if (import.meta.server) {
    const cookie_value = useCookie(cookie_name).value as 'light' | 'dark' | 'system' | null | undefined
    my_color_mode.value = cookie_value === 'system' ? fallback : (cookie_value ?? fallback)
    return my_color_mode as Ref<'light' | 'dark'>
  }

  watchEffect(() => {
    if (real_color_mode.value === 'system') {
      my_color_mode.value = real_color_mode.preference as 'light' | 'dark'
    }
    else {
      my_color_mode.value = real_color_mode.value as 'light' | 'dark'
    }
  })

  return my_color_mode as Ref<'light' | 'dark'>
}
