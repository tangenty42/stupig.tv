import type { Component, NuxtManifest } from 'nuxt/schema'
import { defineNuxtModule } from 'nuxt/kit'

/** Keep global PrimeVue components available on demand without fetching them on every page. */
export function limit_primevue_prefetch(manifest: NuxtManifest, components: Pick<Component, 'global' | 'filePath'>[]) {
  const registered = new Set(components.filter(component => component.global === true).map(component => component.filePath))
  for (const entry of Object.values(manifest)) {
    if (! entry.isEntry || ! entry.module)
      continue

    for (const id of entry.dynamicImports ?? []) {
      const chunk = manifest[id]
      if (! chunk?.isDynamicEntry || ! chunk.module || chunk.resourceType !== 'script')
        continue

      const source = chunk.src?.replaceAll('\\', '/')
      const specifier = source && /(?:^|\/)node_modules\/(primevue\/[^/]+)\/index\.mjs$/.exec(source)?.[1]
      if (specifier && registered.has(specifier))
        chunk.prefetch = false
    }
  }
}

export default defineNuxtModule({
  meta: { name: 'primevue-prefetch' },
  setup(_options, nuxt) {
    nuxt.hook('build:manifest', manifest => limit_primevue_prefetch(manifest, nuxt.apps.default?.components ?? []))
  },
})
