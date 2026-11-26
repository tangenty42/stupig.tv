import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { primevue_preset } from '../../../config/primevue-preset'
import { style_root_id } from '../../../config/ui-style'

const project = resolve(import.meta.dirname, '../../..')
const app = resolve(project, 'app')
const require = createRequire(import.meta.url)
const tailwind = require('tailwindcss/loadConfig.js')(resolve(project, 'tailwind.config.ts'))

tailwind.content = [resolve(app, '**/*.{vue,ts}'), resolve(import.meta.dirname, 'app/**/*.{vue,ts}')].map(glob => glob.replaceAll('\\', '/'))

export default defineNuxtConfig({
  compatibilityDate: '2026-06-22',
  ssr: false,
  devtools: { enabled: false },
  alias: { '~': app, '@shared': resolve(project, 'server/shared') },
  app: { head: { bodyAttrs: { id: style_root_id } } },
  components: [{ path: resolve(app, 'components'), extensions: ['vue'] }],
  css: [resolve(app, 'assets/css/global.css'), resolve(app, 'assets/css/primevue-overrides.css')],
  modules: ['@primevue/nuxt-module', '@nuxt/icon'],
  primevue: {
    options: {
      inputVariant: 'filled',
      ripple: true,
      theme: { preset: primevue_preset, options: { cssLayer: false, darkModeSelector: '.dark' } },
    },
  },
  icon: { provider: 'server', serverBundle: { collections: ['lucide'] }, fallbackToApi: false },
  postcss: { plugins: { tailwindcss: { config: tailwind }, autoprefixer: {} } },
  vite: {
    plugins: [{
      name: 'draft-list-scene',
      enforce: 'pre',
      resolveId(id) {
        if (id.replaceAll('\\', '/').endsWith('/features/content/draft-list'))
          return resolve(import.meta.dirname, 'app/draft-scene.ts')
      },
    }],
  },
})
