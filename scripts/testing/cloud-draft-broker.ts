import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { connectAsync } from 'mqtt'

const docker = process.platform === 'win32' ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe' : 'docker'
const execute = promisify(execFile)

/** Disposable broker; an auth-only relay keeps the isolated app on loopback. */
export async function start_cloud_draft_broker(directory: string, credentials: { username: string, password: string }, authorize: (input: { username?: string, password?: string }) => Promise<object>) {
  await mkdir(directory, { recursive: true })
  const name = `stupig-draft-qa-${randomBytes(8).toString('hex')}`
  const bootstrap = resolve(directory, 'mqtt-bootstrap.json')
  await writeFile(bootstrap, JSON.stringify([{ user_id: credentials.username, password: credentials.password, is_superuser: true }]), { mode: 0o600 })
  const relay = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    try {
      const parts: Buffer[] = []
      let bytes = 0
      for await (const part of request) {
        bytes += part.length
        if (bytes > 2048)
          throw new Error('Auth input too large')
        parts.push(part)
      }
      const input = JSON.parse(Buffer.concat(parts).toString('utf8'))
      response.end(JSON.stringify(await authorize(input)))
    }
    catch { response.end('{"result":"deny"}') }
  })
  await new Promise<void>(accept => relay.listen(0, '0.0.0.0', accept))
  const address = relay.address()
  if (! address || typeof address === 'string')
    throw new Error('No relay port')
  let started = false
  const stop = async () => {
    let cleanup_failed = false
    if (started) {
      if (! /^stupig-draft-qa-[a-f0-9]{16}$/.test(name))
        throw new Error('Invalid broker cleanup identity')
      await execute(docker, ['rm', '-f', '-v', name], { windowsHide: true, timeout: 15000 }).catch(() => {
        cleanup_failed = true
      })
      started = false
    }
    relay.closeAllConnections()
    await new Promise<void>(accept => relay.close(() => accept()))
    await unlink(bootstrap).catch(() => {})
    if (cleanup_failed)
      throw new Error(`Disposable broker cleanup failed: ${name}`)
  }
  try {
    const env = {
      EMQX_NODE__NAME: 'draftqa@127.0.0.1',
      EMQX_AUTHENTICATION__1__MECHANISM: 'password_based', EMQX_AUTHENTICATION__1__BACKEND: 'built_in_database', EMQX_AUTHENTICATION__1__USER_ID_TYPE: 'username',
      EMQX_AUTHENTICATION__1__BOOTSTRAP_FILE: '/tmp/draft-auth.json', EMQX_AUTHENTICATION__1__BOOTSTRAP_TYPE: 'plain',
      EMQX_AUTHENTICATION__2__MECHANISM: 'password_based', EMQX_AUTHENTICATION__2__BACKEND: 'http', EMQX_AUTHENTICATION__2__METHOD: 'post',
      EMQX_AUTHENTICATION__2__URL: `http://host.docker.internal:${address.port}/authn`, EMQX_AUTHENTICATION__2__HEADERS: '{"content-type":"application/json"}',
      // eslint-disable-next-line no-template-curly-in-string -- EMQX expands these broker placeholders.
      EMQX_AUTHENTICATION__2__BODY: '{"username":"${username}","password":"${password}"}', EMQX_AUTHENTICATION__2__REQUEST_TIMEOUT: '3s',
      EMQX_LISTENERS__TCP__DEFAULT__ENABLE_AUTHN: 'true', EMQX_LISTENERS__WS__DEFAULT__ENABLE_AUTHN: 'false',
      EMQX_LISTENERS__WS__DRAFTS__BIND: '0.0.0.0:8086', EMQX_LISTENERS__WS__DRAFTS__ENABLE_AUTHN: 'true',
      EMQX_AUTHORIZATION__NO_MATCH: 'deny', EMQX_AUTHORIZATION__DENY_ACTION: 'disconnect',
      EMQX_AUTHORIZATION__SOURCES__1__TYPE: 'file', EMQX_AUTHORIZATION__SOURCES__1__ENABLE: 'true', EMQX_AUTHORIZATION__SOURCES__1__PATH: '/tmp/draft-acl.conf',
    }
    // Bound the test broker so a busy workstation cannot lose its shared DB
    // when the Erlang VM and browser compilation compete for host memory.
    const args = ['run', '-d', '--name', name, '--cpus=2', '--memory=768m', '--memory-swap=768m', ... (process.platform === 'win32' ? [] : ['--add-host=host.docker.internal:host-gateway']),
      '-p', '127.0.0.1::1883', '-p', '127.0.0.1::8083', '-p', '127.0.0.1::8086',
      '-v', `${bootstrap}:/tmp/draft-auth.json:ro`, '-v', `${resolve('emqx-acl.conf')}:/tmp/draft-acl.conf:ro`,
      ... Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), 'emqx/emqx:6.2.2']
    await execute(docker, args, { windowsHide: true, timeout: 120_000 })
    started = true
    const inspect = await execute(docker, ['inspect', '--format', '{{json .NetworkSettings.Ports}}', name], { windowsHide: true })
    const ports = JSON.parse(inspect.stdout) as Record<string, { HostPort: string }[]>
    const port = (value: string) => Number(ports[value]![0]!.HostPort)
    const tcp_port = port('1883/tcp')
    let ready = false
    for (let attempt = 0; attempt < 60; attempt ++) {
      try {
        const probe = await connectAsync(`mqtt://127.0.0.1:${tcp_port}`, { ... credentials, connectTimeout: 1000, reconnectPeriod: 0, clean: true }, false)
        probe.end(true)
        ready = true
        break
      }
      catch { await delay(500) }
    }
    if (! ready)
      throw new Error('Disposable EMQX did not become ready')
    console.log('cloud-draft broker ready')
    return { tcp_port, public_url: `ws://127.0.0.1:${port('8083/tcp')}/mqtt`, private_url: `ws://127.0.0.1:${port('8086/tcp')}/mqtt`, stop }
  }
  catch (error) {
    await stop()
    throw error
  }
}
