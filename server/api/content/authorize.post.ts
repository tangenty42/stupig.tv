import { authorize_edge_read, edge_read_request } from '@server/services/content/edge-read.service'
import { defineEventHandler, getRequestWebStream, setResponseHeader, setResponseStatus } from 'h3'

/** ESA callback transport. No redirects, cookies, object bytes or cacheable allows. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  try {
    const reader = getRequestWebStream(event)?.getReader()
    if (! reader)
      throw new Error('Missing body')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done)
          break
        size += value.byteLength
        if (size > 8192) {
          await reader.cancel()
          throw new Error('Body limit exceeded')
        }
        chunks.push(value)
      }
    }
    finally { reader.releaseLock() }
    const input = edge_read_request.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (! input.success) {
      setResponseStatus(event, 403)
      return ''
    }
    const proof = await authorize_edge_read(input.data)
    if (! proof) {
      setResponseStatus(event, 403)
      return ''
    }
    setResponseHeader(event, 'X-Content-Authorization', proof)
    setResponseStatus(event, 204)
    return null
  }
  catch {
    // Never serialize signed URLs, SQL details or credentials into errors.
    setResponseStatus(event, 503)
    return ''
  }
})
