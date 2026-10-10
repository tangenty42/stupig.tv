import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { load_settings } from '../../config/lib/loader'
import { settings_schema } from '../../config/lib/schema'
import { settings } from './settings'

describe('application settings', () => {
  it('matches the validated YAML source', () => {
    expect(load_settings()).toEqual(settings)
  })

  it('rejects unknown fields, invalid values and broken relationships', () => {
    expect(settings_schema.safeParse({ ... settings, secret: 'unexpected' }).success).toBe(false)
    const invalid = structuredClone(settings)
    expect(settings_schema.safeParse({ ... invalid, integrations: { ... invalid.integrations, mqtt: { ... invalid.integrations.mqtt, qos: 3 } } }).success).toBe(false)
    invalid.app.content.task.heartbeatSeconds = invalid.app.content.operationLock.ttlSeconds
    expect(settings_schema.safeParse(invalid).success).toBe(false)
    expect(settings_schema.safeParse({ ... settings, app: { ... settings.app, api: { base: `\${SECRET}` } } }).success).toBe(false)
  })

  it('bundles shared settings for browsers without server configuration or parsers', async () => {
    const result = await build({ entryPoints: ['server/shared/settings.ts'], bundle: true, platform: 'browser', outdir: 'unused', write: false, metafile: true })
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs).toContain('server/shared/settings.generated.ts')
    expect(inputs).not.toContain('config/lib/loader.ts')
    expect(inputs).not.toContain('config/lib/schema.ts')
    expect(inputs.some(path => path.includes('/yaml/') || path.includes('/dotenv/'))).toBe(false)
    expect(result.outputFiles.every(file => ! file.text.includes('MYSQL_PASSWORD'))).toBe(true)
  })
})
