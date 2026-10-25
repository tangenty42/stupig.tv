export default defineNuxtPlugin((app) => {
  // Test instrumentation only: the visible loading mask has a timeout fallback
  // and therefore cannot establish that hydration has actually completed.
  Object.assign(window, { __STUPIG_E2E_READY__: () => ! app.isHydrating })
})
