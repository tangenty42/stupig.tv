import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import legacy from '@vitejs/plugin-legacy'
import { transform } from 'esbuild'
import { expect, it } from 'vitest'
import { production_browser_queries } from '../../config/browser-targets'
import { browser_regexp_plugin } from '../../config/browser-transforms'

const require = createRequire(import.meta.url)
const nuxt_require = createRequire(require.resolve('nuxt/package.json'))
const builder_require = createRequire(nuxt_require.resolve('@nuxt/vite-builder/package.json'))

function legacy_regexp(pattern: string, flags?: string) {
  if (flags?.includes('v'))
    throw new SyntaxError('Legacy engine cannot execute RegExp v')
  return new RegExp(pattern, flags)
}

it('preserves Unicode regex semantics through the actual modern and legacy Vite outputs', async () => {
  const { build } = await import(builder_require.resolve('vite'))
  const prefix = join(resolve(tmpdir()), 'stupig-regexp-')
  const directory = await mkdtemp(prefix)
  try {
    const entry = join(directory, 'entry.js')
    await writeFile(entry, String.raw`const emoji = /^\p{RGI_Emoji}$/v; globalThis.result = [emoji.test(input.emoji), emoji.test(input.word), /^[\p{Mark}\p{Control}]+$/v.test(input.combining)]`)
    const bundles = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [browser_regexp_plugin(), legacy({ targets: production_browser_queries, polyfills: false, modernPolyfills: false })],
      build: { write: false, minify: 'oxc', rolldownOptions: { input: entry, output: { codeSplitting: false } } },
    })
    const chunks = bundles.flatMap((bundle: { output: { type: string, fileName: string, code: string, facadeModuleId?: string }[] }) => bundle.output)
      .filter((output: { type: string, facadeModuleId?: string }) => output.type === 'chunk'
        && output.facadeModuleId?.replaceAll('\\', '/') === entry.replaceAll('\\', '/'))
    expect(chunks.some((chunk: { fileName: string }) => chunk.fileName.includes('-legacy'))).toBe(true)
    expect(chunks.some((chunk: { fileName: string }) => ! chunk.fileName.includes('-legacy'))).toBe(true)
    for (const chunk of chunks) {
      // Model the missing constructor capability, not either compiler. Lower
      // any remaining literal syntax as an old parser would require; /v must
      // have been semantically compiled before it reaches this constructor.
      const compiled = await transform(chunk.code, { format: 'iife', target: 'chrome80' })
      const context = {
        input: { emoji: '👨‍👩‍👧‍👦', word: '中文', combining: '\u0301' },
        result: undefined,
        RegExp: legacy_regexp,
        // The browser's module loader owns Vite's modern capability probe.
        require(id: string) {
          if (id.startsWith('data:text/javascript,'))
            return {}
          throw new Error(`Unexpected fixture import: ${id}`)
        },
        System: { register(_dependencies: string[], declare: () => { execute: () => void }) { declare().execute() } },
      }
      runInNewContext(compiled.code, context, { timeout: 1000 })
      expect(context.result).toEqual([true, false, true])
    }
  }
  finally {
    if (resolve(directory).startsWith(prefix))
      await rm(directory, { recursive: true, force: true })
  }
})
