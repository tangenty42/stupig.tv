import type { UploadHashMessage } from './upload-hash'
import { calculate_upload_sha256 } from './upload-hash'

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ file: Blob, chunk_size: number }>) => void
  postMessage: (message: UploadHashMessage) => void
}
worker.onmessage = async ({ data }) => {
  try {
    const digest = await calculate_upload_sha256(data.file, data.chunk_size, undefined, loaded => worker.postMessage({ type: 'progress', loaded }))
    worker.postMessage({ type: 'done', sha256: digest })
  }
  catch { worker.postMessage({ type: 'error' }) }
}
