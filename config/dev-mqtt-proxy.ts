import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { defineNuxtModule } from 'nuxt/kit'

type Upgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => void

export default defineNuxtModule({
  meta: { name: 'dev-mqtt-proxy' },
  setup(_options, nuxt) {
    if (! nuxt.options.dev)
      return

    // Only the CLI's listening dev server needs a proxy. Component tests and
    // builds can load the same Nuxt config without a broker or its ports.
    nuxt.hook('listen', () => {
      const upgrades = new Map<string, Upgrade>()
      const server = nuxt.options.vite.server ??= {}
      const proxies = server.proxy ??= {}
      for (const [path, port] of [
        ['/mqtt', process.env.MQTT_WS_PORT],
        ['/mqtt-drafts', process.env.MQTT_DRAFT_WS_PORT || '8086'],
      ] as const) {
        if (! port || ! /^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
          throw new Error(`Invalid development MQTT listener port for ${path}`)

        // Clients can reconnect while Nuxt is rebuilding. Nitro has no worker
        // to handle these sockets until Vite has configured its proxies.
        upgrades.set(path, (_request, socket) => socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'))
        proxies[`^${path}(?:\\?|$)`] = {
          target: `http://127.0.0.1:${port}/mqtt`,
          ignorePath: true,
          changeOrigin: true,
          // The app owns its cookies. Authentication on the private listener
          // uses the short-lived MQTT CONNECT credentials instead.
          configure(proxy) {
            proxy.on('proxyReqWs', request => request.removeHeader('cookie'))
            upgrades.set(path, (request, socket, head) => proxy.ws(request, socket, head))
          },
          bypass: () => false,
        }
      }

      // In middleware mode Vite has no HTTP server of its own. The CLI already
      // routes HMR itself and hands all other upgrades to Nitro's dev server.
      const nitro = nuxt.server as { upgrade: Upgrade }
      const original = nitro.upgrade.bind(nitro)
      nitro.upgrade = (request, socket, head) => {
        const path = request.url?.split('?', 1)[0] ?? ''
        const upgrade = upgrades.get(path) ?? original
        return upgrade(request, socket, head)
      }
    })
  },
})
