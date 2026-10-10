import { defineNuxtModule } from 'nuxt/kit'
import { generate_settings } from './generate'

export default defineNuxtModule({
  meta: { name: 'app-settings' },
  async setup(_options, nuxt) {
    await generate_settings()
    if (! nuxt.options.dev) {
      return
    }

    nuxt.options.watch.push('config/app-settings.yaml')
    nuxt.hook('builder:watch', async (_event, path) => {
      const normalized_path = path.replaceAll('\\', '/')
      if (normalized_path === 'config/app-settings.yaml' || normalized_path.endsWith('/config/app-settings.yaml')) {
        await generate_settings()
      }
    })
  },
})
