import type { NuxtManifest, NuxtManifestResource } from 'nuxt/schema'
import { expect, it } from 'vitest'
import { limit_primevue_prefetch } from './primevue-prefetch'

it('only removes speculative hints for directly imported global PrimeVue component modules', () => {
  const script = (src: string): NuxtManifestResource => ({
    src, file: 'component.js', isDynamicEntry: true, module: true, resourceType: 'script', prefetch: true, preload: true,
  })
  const manifest: NuxtManifest = {
    app: {
      file: 'app.js', isEntry: true, module: true, imports: ['button'], css: ['app.css'],
      dynamicImports: ['calendar', 'terminal', 'local', 'directive', 'nested', 'icon', 'style', 'alias', 'page'],
    },
    legacy: { file: 'legacy.js', isEntry: true, module: false, dynamicImports: ['legacy_menu'] },
    calendar: { ... script('node_modules/primevue/calendar/index.mjs'), css: ['app.css'] },
    terminal: script('..\\node_modules\\.pnpm\\primevue@4\\node_modules\\primevue\\terminal\\index.mjs'),
    button: script('node_modules/primevue/button/index.mjs'),
    local: script('app/primevue/calendar/index.mjs'),
    directive: script('node_modules/primevue/tooltip/index.mjs'),
    nested: script('node_modules/primevue/calendar/style/index.mjs'),
    icon: script('node_modules/@primevue/icons/calendar/index.mjs'),
    style: { ... script('node_modules/primevue/calendar/index.mjs'), resourceType: 'style', file: 'app.css' },
    alias: { file: 'shared.js', name: 'calendar', isDynamicEntry: true, module: true, resourceType: 'script', prefetch: true },
    page: { ... script('pages/admin.vue'), dynamicImports: ['menu'] },
    menu: script('node_modules/primevue/menu/index.mjs'),
    legacy_menu: script('node_modules/primevue/menu/index.mjs'),
  }
  const expected = structuredClone(manifest)
  expected.calendar!.prefetch = false
  expected.terminal!.prefetch = false

  limit_primevue_prefetch(manifest, [
    ... ['calendar', 'terminal', 'button', 'menu'].map(name => ({ filePath: `primevue/${name}`, global: true as const })),
    { filePath: 'primevue/tooltip', global: false },
  ])

  expect(manifest).toEqual(expected)
})
