import type { UploadTransport } from './task-uploader'

/**
 * Browser transport for the task uploader: XHR rather than fetch, because only
 * XHR reports upload progress (`upload.onprogress`), and the pending rows show
 * a live byte count.
 */
export function create_xhr_upload_transport(): UploadTransport {
  return {
    put: ({ url, body, signal, on_progress }) => new Promise<{ etag: string }>((resolve, reject) => {
      const request = new XMLHttpRequest()
      request.open('PUT', url, true)

      const abort = () => request.abort()
      signal.addEventListener('abort', abort, { once: true })

      const cleanup = () => signal.removeEventListener('abort', abort)

      request.upload.onprogress = (event: ProgressEvent) => {
        if (event.lengthComputable)
          on_progress(event.loaded)
      }
      request.onload = () => {
        cleanup()
        if (request.status < 200 || request.status >= 300) {
          reject(new Error(`上传失败（${request.status}）`))
          return
        }
        // OSS wraps the ETag in quotes; the server compares what we send back
        // against its own listing, so strip them here.
        resolve({ etag: (request.getResponseHeader('ETag') ?? '').replaceAll('"', '') })
      }
      request.onerror = () => {
        cleanup()
        reject(new Error('网络错误，上传失败'))
      }
      request.ontimeout = () => {
        cleanup()
        reject(new Error('上传超时'))
      }
      request.onabort = () => {
        cleanup()
        const error = new Error('上传已取消')
        error.name = 'AbortError'
        reject(error)
      }

      request.send(body)
    }),
  }
}
