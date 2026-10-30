export default defineNuxtPlugin((app) => {
  const errors: { source: string, message: string, stack?: string }[] = []
  const capture = (source: string, error: unknown) => {
    const value = error as Partial<Error> | null
    errors.push({ source, message: value?.message ?? String(error), stack: value?.stack })
  }
  app.hook('app:error', error => capture('app', error))
  app.hook('app:chunkError', ({ error }) => capture('chunk', error))
  app.hook('vue:error', error => capture('vue', error))
  // Test instrumentation only: the visible loading mask has a timeout fallback
  // and therefore cannot establish that hydration has actually completed.
  Object.assign(window, { __STUPIG_E2E_READY__: () => ! app.isHydrating, __STUPIG_E2E_CLIENT_ERRORS__: errors })
  app.hook('app:suspense:resolve', () => {
    const state = window as Window & { __STUPIG_E2E_HYDRATED_AT__?: number }
    state.__STUPIG_E2E_HYDRATED_AT__ ??= performance.now()
  })
})
