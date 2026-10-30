import type { AppConfig } from '../../config/lib/loader'
import { readFileSync } from 'node:fs'
import { public_config_from } from '../../config/lib/loader'

export { public_config_from }

export function runtime_config(): AppConfig {
  const environment = process.env
  const path = environment.STUPIG_E2E_RUNTIME
  if (! path || environment.NODE_ENV !== 'development')
    throw new Error('The E2E configuration requires an isolated development runner')
  const config = JSON.parse(readFileSync(path, 'utf8')) as AppConfig
  if (! /^stupig_e2e_[a-f\d]{32}$/.test(config.db.name))
    throw new Error('E2E database identity is invalid')
  if (! ['127.0.0.1', 'localhost'].includes(config.db.host) || ! Number.isInteger(config.db.port) || config.db.port < 1)
    throw new Error('E2E database connection must remain on the validated local endpoint')
  return config
}
