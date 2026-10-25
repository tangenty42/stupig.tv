import { z } from 'zod'
import { load_environment } from '../../config/lib/environment.mjs'
import { interpolate_config, load_development_tunnel_layer } from '../../config/lib/loader'

const port = z.coerce.number().int().min(1).max(65535)
const schema = z.strictObject({
  frp: z.strictObject({
    executable: z.string().min(1),
    serverAddr: z.string().regex(/^[a-z\d.-]+$/i),
    serverPort: port,
    protocol: z.literal('wss'),
    token: z.string().min(1).refine(value => value !== '<required>', 'Fill DEV_FRP_TOKEN'),
    version: z.literal('0.71.0'),
    proxy: z.strictObject({ name: z.string().regex(/^[\w-]+$/), type: z.literal('tcp'), remotePort: port }),
  }),
  proxy: z.strictObject({
    listenHost: z.literal('127.0.0.1'), listenPort: port,
    targetHost: z.literal('127.0.0.1'), targetPort: port,
    allowedMethod: z.literal('POST'), allowedPath: z.literal('/api/content/authorize'),
  }),
  callbackUrl: z.string().url().refine((value) => {
    const url = new URL(value)
    return url.protocol === 'https:' && ! url.username && ! url.password && ! url.search && ! url.hash && url.pathname === '/api/content/authorize'
  }),
}).refine(value => value.proxy.listenPort !== value.proxy.targetPort, 'Proxy must not forward to itself')

export function parse_dev_auth_config(input: unknown, env: NodeJS.ProcessEnv) {
  const result = schema.safeParse(interpolate_config(input, env))
  if (! result.success)
    throw new Error(`Invalid development tunnel configuration: ${result.error.issues.map(issue => issue.path.join('.') || 'proxy').join(', ')}`)
  return result.data
}

export function load_dev_auth_config(env: NodeJS.ProcessEnv = load_environment({ node_env: 'development' })) {
  return parse_dev_auth_config(load_development_tunnel_layer(), env)
}

export function build_frpc_config(config: ReturnType<typeof load_dev_auth_config>, ca_path: string) {
  const native = {
    serverAddr: config.frp.serverAddr,
    serverPort: config.frp.serverPort,
    loginFailExit: false,
    auth: { method: 'token', token: '__DEV_FRP_TOKEN_JSON__' },
    log: { to: 'console', level: 'info', disablePrintColor: true },
    transport: { protocol: config.frp.protocol, tls: { enable: true, trustedCaFile: ca_path, serverName: config.frp.serverAddr } },
    proxies: [{
      ... config.frp.proxy,
      localIP: config.proxy.listenHost,
      localPort: config.proxy.listenPort,
      healthCheck: { type: 'tcp', timeoutSeconds: 3, maxFailed: 3, intervalSeconds: 10 },
    }],
  }
  return {
    // frp expands its Go template before parsing JSON. Keep the secret out of
    // generated files and serialize the entire JSON value to prevent injection.
    source: JSON.stringify(native, null, 2).replace('"__DEV_FRP_TOKEN_JSON__"', '{{ .Envs.DEV_FRP_TOKEN_JSON }}'),
    token_json: JSON.stringify(config.frp.token),
  }
}
