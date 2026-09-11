import type { AppRouter } from '@server/trpc/router'
import type { inferRouterOutputs } from '@trpc/server'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

type RouterOutputs = inferRouterOutputs<AppRouter>
interface UploadOutputByPath {
  'content.uploadAttachment': RouterOutputs['content']['uploadAttachment']
  'content.replaceAttachment': RouterOutputs['content']['replaceAttachment']
  'profile.uploadAvatar': RouterOutputs['profile']['uploadAvatar']
}

interface TrpcErrorShape {
  message?: string
  data?: {
    httpStatus?: number
  }
}

interface TrpcResponse<T> {
  result?: {
    data?: T
  }
  error?: TrpcErrorShape
}

const DEFAULT_API_ERROR_MESSAGE = '《我们仍未知道那天所发生の网络错误の名字》'

let unauthorized_handled = false
let last_request_at = 0
let presence_started = false
let ping_pending = false

export class TrpcApiError extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function get_trpc_error_status(error: unknown) {
  const value = error as {
    statusCode?: number
    status?: number
    data?: { httpStatus?: number }
  }
  return value?.data?.httpStatus ?? value?.statusCode ?? value?.status
}

function stamp_request_activity() {
  if (import.meta.client) {
    last_request_at = Date.now()
  }
}

export function get_last_trpc_request_at() {
  return last_request_at
}

export function useTrpcClient() {
  const { public: config } = useRuntimeConfig()
  const { logout, user } = useAuth()
  const trpc_path = `${config.api_base.replace(/\/$/, '')}/trpc`
  const trpc_url = import.meta.server
    ? new URL(trpc_path, useRequestURL()).toString()
    : trpc_path
  const ssr_cookie = import.meta.server
    ? useRequestEvent()?.node.req.headers.cookie
    : undefined

  function get_headers() {
    if (import.meta.client) {
      return {}
    }

    return {
      'X-Nuxt-SSR': '1',
      ... (ssr_cookie ? { Cookie: ssr_cookie } : {}),
    }
  }

  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: trpc_url,
        headers: get_headers,
        fetch: async (input, init) => {
          stamp_request_activity()
          return globalThis.fetch(input, {
            ... init,
            credentials: 'include',
          })
        },
      }),
    ],
  })

  async function normalize_error(error: unknown): Promise<never> {
    const status = get_trpc_error_status(error)
    const message = error instanceof Error ? error.message : DEFAULT_API_ERROR_MESSAGE

    if (status === 401 && ! unauthorized_handled) {
      unauthorized_handled = true
      await logout()
    }

    throw new TrpcApiError(message, status)
  }

  async function call<T>(request: Promise<T>) {
    try {
      return await request
    }
    catch (error) {
      return normalize_error(error)
    }
  }

  async function upload<Path extends keyof UploadOutputByPath>(
    path: Path,
    form: FormData,
    on_progress?: (progress: number, loaded: number, total: number) => void,
    signal?: AbortSignal,
  ) {
    type Output = UploadOutputByPath[Path]

    if (import.meta.server) {
      throw new TrpcApiError('上传仅支持在浏览器中进行')
    }

    stamp_request_activity()

    try {
      return await new Promise<Output>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        const abort = () => xhr.abort()
        const cleanup = () => signal?.removeEventListener('abort', abort)
        let total = 0

        xhr.open('POST', `${trpc_url}/${path}`)
        xhr.withCredentials = true
        xhr.setRequestHeader('Accept', 'application/json')
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            total = event.total
            on_progress?.(Math.max(1, Math.round(event.loaded / event.total * 95)), event.loaded, event.total)
          }
        })
        xhr.addEventListener('load', () => {
          cleanup()

          let response: TrpcResponse<Output> | null = null
          try {
            response = JSON.parse(xhr.responseText) as TrpcResponse<Output>
          }
          catch {
            reject(new TrpcApiError(DEFAULT_API_ERROR_MESSAGE, xhr.status || undefined))
            return
          }

          if (response.error) {
            reject(new TrpcApiError(
              response.error.message || DEFAULT_API_ERROR_MESSAGE,
              response.error.data?.httpStatus ?? (xhr.status || undefined),
            ))
            return
          }

          if (! response.result) {
            reject(new TrpcApiError(DEFAULT_API_ERROR_MESSAGE, xhr.status || undefined))
            return
          }

          on_progress?.(100, total, total)
          resolve(response.result.data as Output)
        })
        xhr.addEventListener('error', () => {
          cleanup()
          reject(new TrpcApiError(DEFAULT_API_ERROR_MESSAGE))
        })
        xhr.addEventListener('abort', () => {
          cleanup()
          reject(new TrpcApiError('上传已取消'))
        })

        if (signal?.aborted) {
          reject(new TrpcApiError('上传已取消'))
          return
        }

        signal?.addEventListener('abort', abort, { once: true })
        on_progress?.(0, 0, 0)
        xhr.send(form)
      })
    }
    catch (error) {
      return normalize_error(error)
    }
  }

  if (import.meta.client && ! presence_started) {
    presence_started = true
    const scope = effectScope()
    scope.run(() => {
      watch(useReactiveDateNow(), async () => {
        if (ping_pending || document.visibilityState !== 'visible') {
          return
        }
        if (Date.now() - last_request_at < config.ping_idle_interval_seconds * 1000) {
          return
        }

        if (! user.value) {
          return
        }

        ping_pending = true
        last_request_at = Date.now()
        try {
          await client.presence.ping.query()
        }
        catch {
        }
        finally {
          ping_pending = false
        }
      })
    })
  }

  return {
    client,
    call,
    upload,
  }
}
