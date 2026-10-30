import type { Config } from 'tailwindcss'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import autoprefixer from 'autoprefixer'
import browserslist from 'browserslist'
import { build } from 'esbuild'
import tailwindcss from 'tailwindcss'
import { style_root_id } from '../../config/ui-style'

const require = createRequire(import.meta.url)
// Match Tailwind's config loader; native ESM cannot resolve the existing
// PrimeUI v3 plugin's extensionless tailwindcss/plugin import on Node.
const load_config = require('tailwindcss/loadConfig.js') as (path: string) => Config

const tailwind_config = load_config(resolve(import.meta.dirname, '../../tailwind.config.ts'))
// Inspection uses the actual installed consumer edges. No transitive parser
// or native binary is shipped into application code by this fixture.
const postcss = createRequire(require.resolve('tailwindcss'))('postcss') as (plugins: unknown[]) => {
  process: (css: string, options: { from: string }) => Promise<{ css: string }>
}
const nuxt_require = createRequire(require.resolve('nuxt/package.json'))
const builder_require = createRequire(nuxt_require.resolve('@nuxt/vite-builder/package.json'))
const vite_require = createRequire(builder_require.resolve('vite/package.json'))
const lightning = vite_require('lightningcss') as {
  browserslistToTargets: (browsers: string[]) => Record<string, number>
  transform: (options: { filename: string, code: Buffer, minify: boolean, targets: Record<string, number> }) => { code: Uint8Array }
}

export const modes = ['original', 'nuxt-root', 'body-root', 'all-important'] as const
export type Mode = typeof modes[number]
export type Output = 'postcss' | 'minified'
type FixtureMode = Mode | 'application'

export async function build_css_official_fixture() {
  const root = resolve(import.meta.dirname, '../..')
  const fixture = resolve(root, 'tests/fixtures/css-official-apis/client.ts')
  const [global_css, override_css, bundle] = await Promise.all([
    readFile(resolve(root, 'app/assets/css/global.css'), 'utf8'),
    readFile(resolve(root, 'app/assets/css/primevue-overrides.css'), 'utf8'),
    build({
      entryPoints: [fixture],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      write: false,
      define: {
        'process.env.NODE_ENV': '"production"',
        '__VUE_OPTIONS_API__': 'true',
        '__VUE_PROD_DEVTOOLS__': 'false',
        '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false',
      },
    }),
  ])
  const browsers = browserslist(undefined, { path: root, env: 'production' })
  const targets = lightning.browserslistToTargets(browsers)
  const styles = {} as Record<FixtureMode, Record<Output, { global: string, overrides: string }>>
  for (const mode of [... modes, 'application'] as const) {
    const config = {
      ... tailwind_config,
      content: [fixture, { raw: `<body id="css-app"><div id="__nuxt"></div></body><body id="${style_root_id}"><div class="bg-white dark:bg-slate-900"></div></body>`, extension: 'html' }],
      important: mode === 'application' ? tailwind_config.important : mode === 'all-important' ? true : mode === 'body-root' ? '#css-app' : mode === 'nuxt-root' ? '#__nuxt' : false,
    }
    const compile = async (css: string, name: string) => (await postcss([tailwindcss(config), autoprefixer({ env: 'production' })]).process(css, { from: name })).css
    const compiled = {
      global: await compile(global_css, resolve(root, 'app/assets/css/global.css')),
      overrides: await compile(override_css, resolve(root, 'app/assets/css/primevue-overrides.css')),
    }
    const minify = (css: string) => Buffer.from(lightning.transform({ filename: 'fixture.css', code: Buffer.from(css), minify: true, targets }).code).toString()
    styles[mode] = { postcss: compiled, minified: { global: minify(compiled.global), overrides: minify(compiled.overrides) } }
  }
  return { script: bundle.outputFiles[0]!.text, styles, browsers, targets }
}
