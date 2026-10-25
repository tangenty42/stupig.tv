// 开发回调专用代理：公网隧道只暴露授权回调端点，
// 不把整个 dev server 挂到公网。仅放行 POST /api/content/authorize，
// 转发到本机 dev server（当前 .env.dev 的 APP_PORT 为 3042），
// 其余一律 404。只绑回环，公网入口由隧道进程连进来。
import { createServer, request } from 'node:http'
import { load_dev_auth_config } from './auth-config.ts'

const config = load_dev_auth_config().proxy
const LISTEN_HOST = config.listenHost
const LISTEN_PORT = config.listenPort
const TARGET_HOST = config.targetHost
const TARGET_PORT = config.targetPort
const ALLOWED_PATH = config.allowedPath

const server = createServer((incoming, outgoing) => {
  outgoing.setHeader('X-Dev-Auth-Proxy', '1')
  if (incoming.method !== 'POST' || incoming.url !== ALLOWED_PATH) {
    outgoing.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    outgoing.end('Not Found')
    return
  }
  const forward = request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    path: ALLOWED_PATH,
    method: 'POST',
    headers: { ... incoming.headers, host: `${TARGET_HOST}:${TARGET_PORT}` },
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers)
    response.pipe(outgoing)
  })
  const fail = () => {
    if (! outgoing.headersSent) {
      outgoing.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    outgoing.end('Service Unavailable')
  }
  forward.on('error', fail)
  incoming.on('error', () => forward.destroy())
  incoming.pipe(forward)
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log('Authorization-only proxy ready')
})
