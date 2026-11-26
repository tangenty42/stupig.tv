// 开发回调专用代理：公网隧道只暴露授权回调端点，
// 不把整个 dev server 挂到公网。仅放行 POST /api/hooks/esa/authorize，
// 转发到本机 dev server（当前 .env.dev 的 APP_PORT 为 3042），
// 其余一律 404。只绑回环，公网入口由隧道进程连进来。
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load_dev_auth_config } from './auth-config'
import { dev_https_ca_path } from './https'

export const dev_auth_proxy_version = '2'

export function read_dev_auth_ca() {
  try {
    return readFileSync(dev_https_ca_path)
  }
  catch (cause) {
    throw new Error(`Cannot read the local HTTPS CA at ${dev_https_ca_path}; prepare it before starting the development tunnel`, { cause })
  }
}

export function create_dev_auth_proxy(config: ReturnType<typeof load_dev_auth_config>['proxy'], ca: Buffer) {
  return createServer((incoming, outgoing) => {
    outgoing.setHeader('X-Dev-Auth-Proxy', dev_auth_proxy_version)
    if (incoming.method !== config.allowedMethod || incoming.url !== config.allowedPath) {
      outgoing.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      outgoing.end('Not Found')
      return
    }
    const forward = request({
      host: config.targetHost,
      port: config.targetPort,
      servername: 'localhost',
      ca,
      rejectUnauthorized: true,
      path: config.allowedPath,
      method: config.allowedMethod,
      headers: { ... incoming.headers, host: `localhost:${config.targetPort}` },
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(outgoing)
    })
    forward.on('error', () => {
      if (! outgoing.headersSent)
        outgoing.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      outgoing.end('Service Unavailable')
    })
    incoming.on('error', () => forward.destroy())
    incoming.pipe(forward)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = load_dev_auth_config().proxy
  const server = create_dev_auth_proxy(config, read_dev_auth_ca())
  server.listen(config.listenPort, config.listenHost, () => {
    console.log('Authorization-only proxy ready')
  })
}
