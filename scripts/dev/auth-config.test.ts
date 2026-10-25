import { describe, expect, it } from 'vitest'
import { build_frpc_config, load_dev_auth_config, parse_dev_auth_config } from './auth-config'

const input = {
  // eslint-disable-next-line no-template-curly-in-string -- Exercise the project's literal YAML interpolation syntax.
  frp: { executable: 'frpc', serverAddr: 'frp.example.test', serverPort: 443, protocol: 'wss', token: '${DEV_FRP_TOKEN}', version: '0.71.0', proxy: { name: 'dev-auth', type: 'tcp', remotePort: 15550 } },
  // eslint-disable-next-line no-template-curly-in-string -- Exercise the project's literal YAML interpolation syntax.
  proxy: { listenHost: '127.0.0.1', listenPort: 55500, targetHost: '127.0.0.1', targetPort: '${APP_PORT}', allowedMethod: 'POST', allowedPath: '/api/content/authorize' },
  callbackUrl: 'https://auth.example.test/api/content/authorize',
}

describe('development frp configuration', () => {
  it('loads the nested dev layer without unrelated application credentials', () => {
    const config = load_dev_auth_config({ DEV_FRP_TOKEN: 'fixture-token', APP_PORT: '3042' })
    expect(config.frp).toMatchObject({ token: 'fixture-token', protocol: 'wss', version: '0.71.0' })
    expect(config.proxy.targetPort).toBe(3042)
    expect(config.callbackUrl).toBe('https://stupig-content-auth-dev.cina.cs.tangenty.com/api/content/authorize')
    expect(() => load_dev_auth_config({ APP_PORT: '3042' })).toThrow(/DEV_FRP_TOKEN/)
  })
  it('keeps the token out of the generated file and preserves special characters at rendering', () => {
    const token = 'quotes"and\\slashes#with\nnewline'
    const config = parse_dev_auth_config(input, { DEV_FRP_TOKEN: token, APP_PORT: '3042' })
    const result = build_frpc_config(config, '/tmp/ca.pem')
    expect(result.source).not.toContain(token)
    // frp renders the environment placeholder before parsing JSON; exercise the
    // resulting parser boundary, including a token that cannot be interpolated raw.
    const native = JSON.parse(result.source.replace('{{ .Envs.DEV_FRP_TOKEN_JSON }}', result.token_json))
    expect(native.auth.token).toBe(token)
    expect(native.transport).toMatchObject({ protocol: 'wss', tls: { trustedCaFile: '/tmp/ca.pem', serverName: 'frp.example.test', enable: true } })
    expect(native.proxies).toEqual([expect.objectContaining({ type: 'tcp', localIP: '127.0.0.1', localPort: 55500, remotePort: 15550 })])
  })

  it('rejects incomplete or unsafe configuration without echoing secrets', () => {
    for (const token of ['', '<required>'])
      expect(() => parse_dev_auth_config(input, { DEV_FRP_TOKEN: token, APP_PORT: '3042' })).toThrow(/token/)
    for (const patch of [
      { callbackUrl: null },
      { callbackUrl: 'http://auth.example.test/api/content/authorize' },
      { callbackUrl: 'https://user:secret@auth.example.test/api/content/authorize' },
      { frp: { ... input.frp, proxy: { ... input.frp.proxy, remotePort: null } } },
      { frp: { ... input.frp, serverAddr: 'https://frp.example.test' } },
      { proxy: { ... input.proxy, listenHost: '0.0.0.0' } },
      { proxy: { ... input.proxy, allowedPath: '/' } },
    ]) {
      expect(() => parse_dev_auth_config({ ... input, ... patch }, { DEV_FRP_TOKEN: 'do-not-print-me', APP_PORT: '3042' })).toThrow(/Invalid development tunnel configuration/)
      try {
        parse_dev_auth_config({ ... input, ... patch }, { DEV_FRP_TOKEN: 'do-not-print-me', APP_PORT: '3042' })
      }
      catch (error) { expect(String(error)).not.toContain('do-not-print-me') }
    }
  })
})
