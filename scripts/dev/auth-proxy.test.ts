import type { AddressInfo, Server } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates, TLSSocket } from 'node:tls'
import { expect, it, onTestFinished } from 'vitest'
import { load_dev_auth_config } from './auth-config'
import { create_dev_auth_proxy } from './auth-proxy'
import { prepare_dev_certificate } from './cert'
import { existing_proxy } from './frp'

async function listen(server: Server & { closeAllConnections: () => void }) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  onTestFinished(() => {
    server.closeAllConnections()
    return new Promise<void>(resolve => server.close(() => resolve()))
  })
  return (server.address() as AddressInfo).port
}

function dev_config() {
  return load_dev_auth_config({ APP_PORT: '3042', DEV_FRP_TOKEN: 'fixture-token' })
}

it('limits the relay to the authorization callback and never forwards it to a plaintext server', async () => {
  const config = dev_config()
  let forwarded = false
  config.proxy.targetPort = await listen(createServer((_request, response) => {
    forwarded = true
    response.end('plaintext')
  }))
  config.proxy.listenPort = await listen(create_dev_auth_proxy(config.proxy, Buffer.from(rootCertificates[0]!)))
  await expect(existing_proxy(config)).resolves.toBe(true)
  const origin = `http://127.0.0.1:${config.proxy.listenPort}`
  const callback = origin + config.proxy.allowedPath
  expect((await fetch(callback)).status).toBe(404)
  expect((await fetch(`${callback}?extra=1`, { method: 'POST' })).status).toBe(404)
  const failed = await fetch(callback, { method: 'POST', body: '{}' })
  expect(failed.status).toBe(503)
  expect(await failed.text()).toBe('Service Unavailable')
  expect(forwarded).toBe(false)
})

it('requires the old HTTP-upstream proxy to stop before a tunnel can reuse its port', async () => {
  const config = dev_config()
  config.proxy.listenPort = await listen(createServer((_request, response) => {
    response.writeHead(404, { 'X-Dev-Auth-Proxy': '1' })
    response.end()
  }))
  await expect(existing_proxy(config)).rejects.toThrow(/stop the old tunnel/)
})

it('relays the callback over TLS with the project CA and rejects an untrusted upstream', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stupig-auth-proxy-'))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  prepare_dev_certificate(directory)
  const config = dev_config()
  const tls = { cert: readFileSync(join(directory, 'localhost.pem')), key: readFileSync(join(directory, 'localhost.key')) }
  let received = 0
  config.proxy.targetPort = await listen(createHttpsServer(tls, (request, response) => {
    received += 1
    response.writeHead(403, { 'x-upstream-sni': request.socket instanceof TLSSocket ? request.socket.servername || '' : '' })
    request.pipe(response)
  }))

  async function post(ca: Buffer) {
    const port = await listen(create_dev_auth_proxy(config.proxy, ca))
    return fetch(`http://127.0.0.1:${port}${config.proxy.allowedPath}`, { method: 'POST', body: '{}' })
  }
  const trusted = await post(readFileSync(join(directory, 'ca.pem')))
  expect(trusted.status).toBe(403)
  expect(trusted.headers.get('x-upstream-sni')).toBe('localhost')
  expect(await trusted.text()).toBe('{}')
  const untrusted = await post(Buffer.from(rootCertificates[0]!))
  expect(untrusted.status).toBe(503)
  expect(await untrusted.text()).toBe('Service Unavailable')
  expect(received).toBe(1)
})
