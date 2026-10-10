import { public_config_from, runtime_config } from '@config/loader'
import { public_config_schema } from '@config/schema'

export default defineNitroPlugin((nitro_app) => {
  const config = runtime_config()
  const public_config = public_config_schema.parse(public_config_from(config))

  nitro_app.hooks.hook('request', (event) => {
    // Nitro freezes the process-wide config; request configs are mutable clones.
    Object.assign(useRuntimeConfig(event).public, structuredClone(public_config))
  })
})
