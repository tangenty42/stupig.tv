import { describe, expect, it } from 'vitest'
import { load_dev_auth_config } from '../dev/auth-config'
import { load_publish_config, parse_publish_config, publish_plan, require_publish_credentials } from './config'

const env = {
  NODE_ENV: 'development',
  ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID: 'test-publish-id',
  ALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET: 'test-publish-secret',
  ALIYUN_ESA_AUTH_KEY: 'a'.repeat(32),
  ALIYUN_ESA_SITE_ID: '12345',
}

describe('eSA publication configuration', () => {
  it('uses YAML targets and scoped selected credentials without requiring application secrets', () => {
    const dev = load_publish_config(env)
    const prod = load_publish_config({ ... env, NODE_ENV: 'production', ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID: 'prod-id' })
    expect(dev).toMatchObject({ name: 'stupig-content-auth-bypass-dev', appEnvironment: 'dev', environment: 'production', accessKeyId: 'test-publish-id' })
    expect(prod).toMatchObject({ name: 'stupig-content-auth-bypass-prod', appEnvironment: 'prod', environment: 'production', accessKeyId: 'prod-id' })
    expect(dev.callbackUrl).toBe(load_dev_auth_config({ DEV_FRP_TOKEN: 'test-token', APP_PORT: '3042' }).callbackUrl)
    expect(prod.callbackUrl).toBe('https://www.stupig.tv/api/content/authorize')
    expect(prod.deliveryUrl).not.toBe(dev.deliveryUrl)
    expect(() => require_publish_credentials(dev)).not.toThrow()
    const plan = JSON.stringify(publish_plan(dev))
    for (const secret of [env.ALIYUN_ESA_AUTH_KEY, env.ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID, env.ALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET])
      expect(plan).not.toContain(secret)
  })

  it('allows offline plans with placeholders but blocks remote commands', () => {
    const config = load_publish_config({ NODE_ENV: 'production', ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID: '<required>' })
    expect(publish_plan(config)).toMatchObject({ credentialsConfigured: false, authKeyConfigured: false })
    expect(() => require_publish_credentials(config)).toThrow('accessKeyId')
  })

  it.each([
    { callbackUrl: 'https://stupig-static-dev.oss.tangenty.cn/api/content/authorize' },
    { callbackUrl: 'http://auth.example.test/api/content/authorize' },
    { callbackUrl: 'https://user:password@auth.example.test/api/content/authorize' },
    { callbackUrl: 'https://auth.example.test/' },
    { deliveryUrl: 'https://cdn.example.test/content/' },
    { entry: '../outside.mjs' },
    { environment: 'prod' },
  ])('rejects unsafe destination %j', (patch) => {
    const { appEnvironment: _, ... config } = load_publish_config(env)
    // Normalize the already-resolved path back to the tracked relative entry.
    expect(() => parse_publish_config({ ... config, entry: 'config/esa/content-auth.mjs', ... patch }, env)).toThrow()
  })
})
