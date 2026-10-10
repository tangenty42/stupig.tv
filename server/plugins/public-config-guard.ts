import { public_config_from, runtime_config } from '@config/loader'
import { public_config_schema } from '@config/schema'

export default defineNitroPlugin(() => {
  const config = runtime_config()
  const public_config = useRuntimeConfig().public
  Object.assign(public_config, public_config_from(config))
  public_config_schema.parse(public_config)
})
