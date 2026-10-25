import type { ContentUploadPartGrant, ContentUploadSession } from '@shared/types/content-upload'
import { md5 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { settings } from '@shared/settings'

export interface UploadSessionApi {
  resume: () => Promise<ContentUploadSession>
  initialize: () => Promise<ContentUploadSession>
  sign: (part: number, md5: string) => Promise<ContentUploadPartGrant>
  seal: () => Promise<ContentUploadSession>
  cancel: () => Promise<ContentUploadSession>
}
export interface UploadProgress { phase: 'hashing' | 'uploading' | 'verifying' | 'ready', loaded: number, total: number, confirmed?: number }

/** Bounded memory, including a reselected multi-GB file. Never trust its name/size alone. */
export async function upload_file_sha256(file: Blob, signal?: AbortSignal, progress?: (value: UploadProgress) => void) {
  const hash = sha256.create()
  const chunk_size = settings.app.content.upload.partSizeMb * 1024 ** 2
  try {
    for (let offset = 0; offset < file.size; offset += chunk_size) {
      signal?.throwIfAborted()
      hash.update(new Uint8Array(await file.slice(offset, offset + chunk_size).arrayBuffer()))
      progress?.({ phase: 'hashing', loaded: Math.min(offset + chunk_size, file.size), total: file.size })
    }
    signal?.throwIfAborted()
    return bytesToHex(hash.digest())
  }
  finally {
    hash.destroy()
  }
}

/**
 * Official SDK schedules parts/checkpoints. Its supported urllib boundary
 * replaces locally generated placeholder signatures with server capabilities.
 * No placeholder credential, SDK Authorization or STS header reaches the wire.
 */
export function create_browser_upload(api: UploadSessionApi, progress?: (value: UploadProgress) => void) {
  let active: AbortController | null = null
  let sdk_cancel: (() => void) | null = null
  async function run(file: File) {
    if (active)
      throw new Error('该上传正在进行')
    const controller = new AbortController()
    active = controller
    const signal = controller.signal
    try {
      let state = await api.resume()
      signal.throwIfAborted()
      if (state.status === 'queued' || state.status === 'running')
        state = await api.initialize()
      signal.throwIfAborted()
      if (file.size !== state.size || await upload_file_sha256(file, signal, progress) !== state.sha256)
        throw new Error('请选择内容一致的原文件')
      if (state.status === 'running' || state.status === 'verifying') {
        progress?.({ phase: 'verifying', loaded: file.size, total: file.size })
        state = await api.seal()
      }
      signal.throwIfAborted()
      if (state.status === 'ready' || state.status === 'completed')
        return state
      if (state.status !== 'uploading' || ! state.key || ! state.upload_id || ! state.part_size)
        throw new Error('上传会话当前不可继续')
      const current = state
      const part_size = state.part_size
      const offsets = new Map(state.parts.map(part => [part.part_number, part.size]))
      const confirmed = new Map(offsets)
      const emit = () => progress?.({ phase: 'uploading', loaded: [... offsets.values()].reduce((sum, value) => sum + value, 0), total: file.size,
        confirmed: [... confirmed.values()].reduce((sum, value) => sum + value, 0) })
      const transport = async (raw_url: string, options: { method: string, content: Uint8Array }) => {
        signal.throwIfAborted()
        const url = new URL(raw_url)
        if (decodeURIComponent(url.pathname) !== `/${current.key}` || url.searchParams.get('uploadId') !== current.upload_id)
          throw new Error('SDK 请求与上传会话不符')
        if (options.method === 'POST' && [... url.searchParams.keys()].join() === 'uploadId') {
          progress?.({ phase: 'verifying', loaded: file.size, total: file.size })
          state = await api.seal()
          if (state.status !== 'ready' && state.status !== 'completed')
            throw new Error('上传尚未确认就绪')
          const etag = state.object_etag ?? ''
          return { status: 200, headers: { etag }, res: { status: 200, headers: { etag } },
            data: `<CompleteMultipartUploadResult><ETag>${etag}</ETag></CompleteMultipartUploadResult>` }
        }
        const number = Number(url.searchParams.get('partNumber'))
        const size = Math.min(part_size, file.size - (number - 1) * part_size)
        if (options.method !== 'PUT' || [... url.searchParams.keys()].sort().join() !== 'partNumber,uploadId'
          || ! Number.isInteger(number) || number < 1 || size <= 0 || options.content.byteLength !== size) {
          throw new Error('SDK 分片与固定计划不符')
        }
        const body = new Uint8Array(options.content)
        const checksum = btoa(String.fromCharCode(... md5(body)))
        const grant = await api.sign(number, checksum)
        const signed = new URL(grant.url)
        const endpoint = new URL(current.target.endpoint)
        if (signed.protocol !== 'https:' || signed.host !== `${current.target.bucket}.${endpoint.host}`
          || decodeURIComponent(signed.pathname) !== `/${current.key}` || signed.searchParams.get('uploadId') !== current.upload_id
          || signed.searchParams.get('partNumber') !== String(number) || grant.method !== 'PUT'
          || grant.headers['Content-Length'] !== String(size) || grant.headers['Content-MD5'] !== checksum
          || grant.headers['Content-Type'] !== 'application/octet-stream') {
          throw new Error('分片授权与上传会话不符')
        }
        signal.throwIfAborted()
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          const abort = () => xhr.abort()
          xhr.open('PUT', grant.url)
          xhr.timeout = settings.app.content.upload.requestTimeoutSeconds * 1000
          xhr.responseType = 'arraybuffer'
          // Content-Length is forbidden to browser JS. Blob supplies its actual
          // length automatically, which must still match the server signature.
          xhr.setRequestHeader('Content-Type', grant.headers['Content-Type'])
          xhr.setRequestHeader('Content-MD5', grant.headers['Content-MD5'])
          xhr.upload.onprogress = (event) => {
            offsets.set(number, Math.min(event.loaded, size))
            emit()
          }
          xhr.onload = () => {
            const headers: Record<string, string> = {}
            for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
              const colon = line.indexOf(':')
              if (colon > 0)
                headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim()
            }
            resolve({ status: xhr.status, headers, res: { status: xhr.status, headers }, data: new TextDecoder().decode(xhr.response) })
          }
          xhr.onerror = xhr.ontimeout = () => reject(new Error('分片传输中断'))
          xhr.onabort = () => reject(new DOMException('上传已暂停', 'AbortError'))
          xhr.onloadend = () => signal.removeEventListener('abort', abort)
          signal.addEventListener('abort', abort, { once: true })
          xhr.send(new Blob([body]))
          if (signal.aborted)
            xhr.abort()
        })
      }
      const { default: OSS } = await import('ali-oss')
      const sdk_options = { ... current.target, secure: true, authorizationV4: true,
        accessKeyId: 'server-signed-request', accessKeySecret: 'server-signed-request', stsToken: 'server-signed-request',
        refreshSTSTokenInterval: settings.app.content.upload.urlTtlSeconds * 1000,
        urllib: { request: transport } }
      const sdk = new OSS(sdk_options)
      sdk_cancel = () => sdk.cancel()
      emit()
      await sdk.multipartUpload(current.key!, file, {
        checkpoint: { file, name: current.key!, fileSize: file.size, partSize: part_size, uploadId: current.upload_id!,
          doneParts: current.parts.map(part => ({ number: part.part_number, etag: part.etag })) },
        partSize: part_size, parallel: 1,
        progress: async (_ratio, checkpoint) => {
          if (checkpoint) {
            for (const part of checkpoint.doneParts) {
              offsets.set(part.number, Math.min(part_size, file.size - (part.number - 1) * part_size))
              confirmed.set(part.number, Math.min(part_size, file.size - (part.number - 1) * part_size))
            }
          }
          emit()
        },
      })
      signal.throwIfAborted()
      progress?.({ phase: 'ready', loaded: file.size, total: file.size })
      return state
    }
    catch (error) {
      if (signal.aborted)
        throw new DOMException('上传已暂停，可重新选择原文件继续', 'AbortError')
      // SDK errors can contain request URLs/checkpoints. Keep them out of UI logs.
      if (error instanceof Error && error.message === '请选择内容一致的原文件')
        throw error
      throw new Error('上传未完成，可稍后继续或重新查询会话状态')
    }
    finally {
      active = null
      sdk_cancel = null
    }
  }
  function pause() {
    active?.abort()
    sdk_cancel?.()
  }
  return { run, pause, cancel: async () => {
    pause()
    return api.cancel()
  } }
}
