import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import { Window } from 'happy-dom'
import { nextTick } from 'vue'

const require = createRequire(import.meta.url)

async function package_info(entry: string) {
  let directory = dirname(entry)
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (metadata.name && metadata.version)
        return { directory, name: metadata.name, version: metadata.version }
    }
    catch (error) {
      if (! (error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw error
    }
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error(`Cannot identify installed package for ${entry}`)
    directory = parent
  }
}

// Resolve from each declared consumer to inspect the installed dependency.
// These are diagnostic probes, not an application adapter or browser core.
export async function probe_css_cascade_feasibility() {
  const view_require = createRequire(require.resolve('@codemirror/view'))
  const prime_require = createRequire(require.resolve('primevue/config'))
  const style_mod_entry = view_require.resolve('style-mod')
  const base_style_entry = prime_require.resolve('@primevue/core/base/style')
  const use_style_entry = prime_require.resolve('@primevue/core/usestyle')
  const styled_entry = prime_require.resolve('@primeuix/styled')
  const [{ StyleModule }, { default: BaseStyle }, { useStyle }, { Theme }, { default: Aura }] = await Promise.all([
    import(pathToFileURL(style_mod_entry).href),
    import(pathToFileURL(base_style_entry).href),
    import(pathToFileURL(use_style_entry).href),
    import(pathToFileURL(styled_entry).href),
    import('@primeuix/themes/aura'),
  ])

  const versions: Record<string, string> = {}
  for (const entry of [require.resolve('@codemirror/view'), style_mod_entry, require.resolve('primevue/config'), styled_entry]) {
    const info = await package_info(entry)
    versions[info.name] = info.version
  }

  let finish_calls = 0
  const manual = new StyleModule({
    '.cascade-probe': { color: 'red', display: 'none !important' },
  }, {
    finish: (selector: string) => {
      finish_calls ++
      return `${selector}:not(#cascade-probe-guard)`
    },
  })
  const state = EditorState.create({
    extensions: [
      basicSetup,
      EditorView.theme({ '.cascade-probe': { color: 'red', display: 'none !important' } }),
      syntaxHighlighting(HighlightStyle.define([{ tag: tags.heading, color: 'blue' }])),
    ],
  })
  const modules = state.facet(EditorView.styleModule)
  const generated = modules.map(module => module.getRules())

  const window = new Window()
  const globals = { window, document: window.document, ShadowRoot: window.ShadowRoot, Element: window.Element, HTMLElement: window.HTMLElement }
  const original_globals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries(globals)) {
    original_globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const observed_updates: (string | undefined)[] = []
  let style: { unload: () => void } | undefined
  try {
    const current_style = useStyle('.cascade-probe { color: red }', {
      document: window.document,
      name: 'cascade-feasibility',
      manual: true,
      // Even the implementation's update notification runs after the write;
      // its return value cannot supply transformed CSS. It is not a public
      // transform contract and is used here only to demonstrate the timing.
      onUpdated: () => {
        observed_updates.push(window.document.querySelector('style')?.textContent)
        return '.cascade-probe { color: green }'
      },
    })
    style = current_style
    current_style.load()
    current_style.css.value = '.cascade-probe { color: blue }'
    await nextTick()
  }
  finally {
    try {
      style?.unload()
    }
    finally {
      for (const [name, descriptor] of original_globals) {
        if (descriptor)
          Object.defineProperty(globalThis, name, descriptor)
        else
          delete (globalThis as Record<string, unknown>)[name]
      }
      await window.happyDOM.close()
    }
  }

  // Theme is process-global in the dependency; restore it for callers/tests.
  const original_theme = Theme.getTheme()
  let base_ssr = ''
  let theme_ssr = ''
  try {
    Theme.setTheme({ preset: Aura, options: { cssLayer: false, darkModeSelector: '.dark' } })
    base_ssr = BaseStyle.getStyleSheet()
    theme_ssr = BaseStyle.getCommonThemeStyleSheet()
  }
  finally {
    Theme.setTheme(original_theme)
  }

  return {
    versions,
    codemirror: {
      finish_calls,
      manual_css: manual.getRules(),
      facet_module_count: modules.length,
      facet_css_bytes: Buffer.byteLength(generated.join('\n')),
      project_theme_css: generated.filter(css => css.includes('.cascade-probe')),
      // Adding a module through the public facet leaves existing providers.
      additive_facet_module_count: EditorState.create({
        extensions: [state.facet(EditorView.styleModule).map(module => EditorView.styleModule.of(module)), EditorView.theme({ '.cascade-extra': { color: 'green' } })],
      }).facet(EditorView.styleModule).length,
    },
    primevue: {
      observed_updates,
      base_ssr_bytes: Buffer.byteLength(base_ssr),
      base_ssr_has_style_element: base_ssr.includes('<style '),
      theme_ssr_bytes: Buffer.byteLength(theme_ssr),
      theme_ssr_has_host: theme_ssr.includes(':host'),
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2)
    throw new Error('This diagnostic accepts no arguments')
  // Successful diagnostics do not mean adapter feasibility or compatibility
  // passed; the report records observations, not a production enable switch.
  console.log(JSON.stringify(await probe_css_cascade_feasibility(), null, 2))
}
