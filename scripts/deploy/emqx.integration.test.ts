import type { MqttClient } from 'mqtt'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connectAsync } from 'mqtt'
import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

const image = process.env.STUPIG_EMQX_IMAGE
const docker = process.platform === 'win32' ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe' : 'docker'
const root = resolve(import.meta.dirname, '../..')

describe.skipIf(! image)('managed production mqtt broker', () => {
  it('initializes credentials, rejects unauthorized traffic and retains users after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stupig-mqtt-'))
    const project = `stupig-mqtt-${randomUUID().slice(0, 8)}`
    const username = 'deployment-probe'
    const password = `fixture-"'\\$#,-${randomUUID()}`
    const production = parse(readFileSync(join(root, 'docker-compose.yml'), 'utf8'))
    const broker = production.services.emqx
    const clients: MqttClient[] = []
    const messages: string[] = []
    const environment = { ... process.env, MQTT_USERNAME: username, MQTT_PASSWORD: password }
    const compose_file = join(directory, 'compose.yaml')
    writeFileSync(compose_file, stringify({
      services: { emqx: { ... broker, image, ports: ['127.0.0.1::8083'] } },
      networks: { mqtt: production.networks.mqtt },
      volumes: production.volumes,
    }))
    const compose_args = ['compose', '-p', project, '-f', compose_file]

    function execute(args: string[], input?: string) {
      return spawnSync(docker, args, { encoding: 'utf8', env: environment, input, timeout: 180_000 })
    }

    function checked(args: string[], input?: string) {
      const result = execute(args, input)
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      return result.stdout.trim()
    }

    async function browser(endpoint: string, credentials = {}) {
      const client = await connectAsync(`ws://${endpoint}/mqtt`, {
        reconnectPeriod: 0, connectTimeout: 5000, clean: true, ... credentials,
      })
      client.on('error', () => {})
      clients.push(client)
      return client
    }

    async function denied(client: MqttClient, action: () => void) {
      const disconnected = new Promise<void>((resolve_disconnect, reject) => {
        const timer = setTimeout(() => reject(new Error('broker did not disconnect denied operation')), 5000)
        client.once('close', () => {
          clearTimeout(timer)
          resolve_disconnect()
        })
      })
      action()
      await disconnected
    }

    try {
      checked([... compose_args, 'config', '-q'])
      checked([... compose_args, 'up', '-d', '--wait', '--wait-timeout', '120'])
      const container = checked([... compose_args, 'ps', '-q', 'emqx'])
      const ports = JSON.parse(checked(['inspect', '--format', '{{json .NetworkSettings.Ports}}', container]))
      const binding = ports['8083/tcp']?.[0]
      expect(binding, JSON.stringify(ports)).toMatchObject({ HostIp: '127.0.0.1', HostPort: expect.stringMatching(/^\d+$/) })
      const endpoint = `127.0.0.1:${binding.HostPort}`
      const subscriber = await browser(endpoint)
      const topic = `stupig/sync/__deployment_probe_${randomUUID()}`
      const payload = randomUUID()
      subscriber.on('message', (_topic, body) => messages.push(body.toString()))
      const granted = await subscriber.subscribeAsync(topic, { qos: 1 })
      expect(granted[0]?.qos).toBe(1)
      const received = new Promise<void>((resolve_message, reject) => {
        const timer = setTimeout(() => reject(new Error('authenticated publisher message was not delivered')), 5000)
        subscriber.once('message', (_topic, body) => {
          clearTimeout(timer)
          expect(body.toString()).toBe(payload)
          resolve_message()
        })
      })
      const publish = `
        begin
          {ok, Bootstrap} = file:read_file(os:getenv("EMQX_AUTHENTICATION__1__BOOTSTRAP_FILE")),
          [#{<<"user_id">> := Username, <<"password">> := Password}] = emqx_utils_json:decode(Bootstrap),
          {ok, Publisher} = emqtt:start_link([{host,{127,0,0,1}}, {port,1883}, {username,Username}, {password,Password}]),
          unlink(Publisher),
          {ok, _} = emqtt:connect(Publisher),
          {ok, _} = emqtt:publish(Publisher, <<"${topic}">>, <<"${payload}">>, 1),
          emqtt:stop(Publisher),
          {ok, Anonymous} = emqtt:start_link([{host,{127,0,0,1}}, {port,1883}]),
          unlink(Anonymous),
          {error, _} = emqtt:connect(Anonymous),
          catch emqtt:stop(Anonymous),
          {ok, WrongPassword} = emqtt:start_link([{host,{127,0,0,1}}, {port,1883}, {username,Username}, {password,<<"invalid">>}]),
          unlink(WrongPassword),
          {error, _} = emqtt:connect(WrongPassword),
          catch emqtt:stop(WrongPassword),
          verified
        end
      `
      checked(['exec', container, '/bin/sh', '/opt/emqx/etc/production-entrypoint.sh', '--cli', 'eval', publish])
      await received

      for (const credentials of [{}, { username, password: 'invalid' }, { username, password }]) {
        const client = await browser(endpoint, credentials)
        await denied(client, () => client.publish(topic, 'forged-message', { qos: 1 }, () => {}))
      }
      for (const forbidden of ['outside/#', '#', '$SYS/#']) {
        const client = await browser(endpoint)
        await denied(client, () => client.subscribe(forbidden, () => {}))
      }
      expect(messages).toEqual([payload])

      const bootstrap_path = broker.environment.EMQX_AUTHENTICATION__1__BOOTSTRAP_FILE
      const health_command = broker.healthcheck.test.slice(1)
      checked(['exec', '-i', container, '/bin/sh', '-c', `cat > ${bootstrap_path}`], JSON.stringify([
        { user_id: username, password: 'invalid', is_superuser: true },
      ]))
      expect(execute(['exec', container, ... health_command]).status).not.toBe(0)
      expect(checked(['inspect', '--format', '{{.State.Running}}', container])).toBe('true')
      checked(['exec', '-i', container, '/bin/sh', '-c', `cat > ${bootstrap_path}`], JSON.stringify([
        { user_id: username, password, is_superuser: true },
      ]))
      checked(['exec', container, ... health_command])
      for (const client of clients)
        client.end(true)
      checked([... compose_args, 'restart', 'emqx'])
      checked([... compose_args, 'up', '-d', '--wait', '--wait-timeout', '120'])
      checked(['exec', checked([... compose_args, 'ps', '-q', 'emqx']), ... health_command])
    }
    catch (error) {
      const logs = execute([... compose_args, 'logs', '--tail', '80'])
      const container = execute([... compose_args, 'ps', '-q', 'emqx']).stdout.trim()
      const health = execute(['inspect', '--format', '{{json .State.Health}}', container])
      throw new Error(`${String(error)}\n${logs.stdout}\n${logs.stderr}\n${health.stdout}`.replaceAll(password, '[redacted]'), { cause: error })
    }
    finally {
      for (const client of clients)
        client.end(true)
      const result = execute([... compose_args, 'down', '--volumes', '--remove-orphans'])
      rmSync(directory, { recursive: true, force: true })
      expect(result.status, result.stderr).toBe(0)
    }
  }, 240_000)
})
