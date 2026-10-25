/* global ResponseBypass: readonly */
import { createHash, createHmac, randomUUID } from 'node:crypto'

const TTL_SECONDS = 300
const CLOCK_SKEW_SECONDS = 30
const DEBUG_BUILD = 'content-bypass-debug-v1'

/** @param {Request} request @param {string} stage @param {boolean | null} allowed @param {number | null} status */
function trace_bypass(request, stage, allowed = null, status = null) {
  // Only our synthetic QA paths; never log query strings, names or credentials.
  const path = new URL(request.url).pathname
  if (! /^\/content\/att\/qa-esa-bypass\/[a-f\d-]{36}\/(?:headers|probe)\.bin$/.test(path))
    return
  try {
    // eslint-disable-next-line no-console -- ESA uses alert for live logs; TODO remove this QA tracing after diagnosis.
    if (typeof console.alert === 'function') {
      // eslint-disable-next-line no-console -- ESA uses alert for live logs; TODO remove this QA tracing after diagnosis.
      console.alert(JSON.stringify({ build: DEBUG_BUILD, stage, method: request.method, path, allowed, status }))
    }
  }
  catch {
    // Diagnostic logging must not change an authentication decision.
  }
}

/** @param {string} privateKey @param {number} ttlSeconds @param {Request} request */
export function authorize_content_request(privateKey, ttlSeconds, request) {
  const deny = (status = 403) => ({ status, url: null, disposition: null })
  if (! privateKey || privateKey === 'REPLACE_WITH_RANDOM_SECRET')
    return deny(503)
  if (! ['GET', 'HEAD'].includes(request.method))
    return deny(405)
  const url = new URL(request.url)
  const headerName = 'response-content-disposition'
  if (url.searchParams.getAll('auth_key').length !== 1
    || url.searchParams.getAll(headerName).length > 1
    || url.searchParams.getAll('access').length > 1
    || [... url.searchParams.keys()].some(key => ! ['auth_key', headerName, 'access'].includes(key))) {
    return deny()
  }
  const match = /^(\d{10})-([a-z\d]{1,64})-(\d{1,20})-([a-f\d]{32})$/i.exec(url.searchParams.get('auth_key') ?? '')
  if (! match)
    return deny()
  const [, timestamp, rand, uid, signature] = match
  const issuedAt = Number(timestamp)
  const now = Math.floor(Date.now() / 1000)
  if (issuedAt > now + CLOCK_SKEW_SECONDS || now >= issuedAt + ttlSeconds)
    return deny()
  const hash = createHash('md5').update([url.pathname, timestamp, rand, uid, privateKey].join('-')).digest('hex')
  if (hash !== signature)
    return deny()
  const disposition = url.searchParams.get(headerName)
  const access = url.searchParams.get('access')
  if (disposition !== null && ! /^(?:attachment|inline); filename\*=UTF-8''(?:[\w.~-]|%[a-f\d]{2})+$/i.test(disposition))
    return deny()
  if (access !== null
    ? (! /^[\w-]{1,2048}$/.test(access) || uid !== '1' || content_signature_metadata(disposition ?? '', access) !== rand)
    : (uid !== '0' || (disposition === null ? rand.length === 64 : content_signature_metadata(disposition) !== rand))) {
    return deny()
  }
  return { status: 200, url, disposition }
}

/** @param {string} disposition @param {string | undefined} access */
export function content_signature_metadata(disposition, access) {
  return createHash('sha256').update(access === undefined ? disposition : JSON.stringify([disposition, access])).digest('hex')
}

/** A nonce-bound acknowledgement prevents stale/cached authorization replies. */
export function content_authorization_proof(privateKey, nonce, url, method) {
  return createHmac('sha256', privateKey).update(JSON.stringify(['content-read-v1', nonce, url, method])).digest('hex')
}

/**
 * Only a fixed HTTPS authorization endpoint is fetched, never a client URL.
 * No positive authorization cache and no fallback on timeout or bad responses.
 * @param {string} privateKey
 * @param {string} endpoint
 * @param {number} timeoutMs
 * @param {typeof fetch} authorizationFetch
 */
export function create_content_authorizer(privateKey, endpoint, timeoutMs = 5000, authorizationFetch = fetch) {
  return async (request) => {
    let target
    try {
      target = new URL(endpoint)
    }
    catch { return 503 }
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash
      || target.origin === new URL(request.url).origin || ! Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) {
      return 503
    }
    if (! new URL(request.url).searchParams.has('access'))
      return 403
    const nonce = randomUUID()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await authorizationFetch(target.href, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ url: request.url, method: request.method, nonce }),
      })
      const proof = response.headers.get('X-Content-Authorization')
      await response.body?.cancel()
      if (response.status === 403)
        return 403
      return response.status === 204 && proof === content_authorization_proof(privateKey, nonce, request.url, request.method) ? 200 : 503
    }
    catch { return 503 }
    finally { clearTimeout(timer) }
  }
}

/**
 * @param {string} privateKey
 * @param {number} ttlSeconds
 * @param {typeof fetch} originFetch
 */
export function create_content_auth(privateKey, ttlSeconds = TTL_SECONDS, originFetch = fetch, authorize) {
  /** @param {Request} request */
  return async function handleRequest(request) {
    const { status, url, disposition } = authorize_content_request(privateKey, ttlSeconds, request)
    if (! url)
      return new Response('Forbidden', { status, headers: { 'Cache-Control': 'no-store' } })
    let current = 503
    try {
      current = authorize ? await authorize(request) : 503
    }
    catch { /* Authorization failures must never reach cached object bytes. */ }
    if (current !== 200)
      return new Response('Forbidden', { status: current, headers: { 'Cache-Control': 'no-store' } })
    // Always validate before fetch. Clean subrequests share the object cache;
    // filename headers are applied AFTER fetch and never enter that cache.
    url.search = ''
    const headers = new Headers(request.headers)
    headers.delete('Authorization')
    headers.delete('Cookie')
    // Signed URLs are bearer capabilities; anonymous CORS enables editor canvas
    // reads without caching a response tied to the first request's Origin.
    headers.delete('Origin')
    const response = await originFetch(new Request(url.toString(), {
      method: request.method, headers, redirect: 'manual',
    }))
    const output = new Response(response.body, response)
    output.headers.set('Cache-Control', 'private, no-store')
    output.headers.set('Access-Control-Allow-Origin', '*')
    output.headers.delete('Access-Control-Allow-Credentials')
    output.headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Range, Accept-Ranges, ETag')
    if (disposition !== null && (response.ok || response.status === 304))
      output.headers.set('Content-Disposition', disposition)
    return output
  }
}

/** @param {boolean} allowed @param {number} status */
function edge_bypass_response(allowed, status) {
  if (allowed)
    return new ResponseBypass(true)
  return new ResponseBypass(false, { status })
}

/**
 * Fetch only the authorization decision, never object bytes. Native ESA rules
 * supply query cleanup, cache keys and outgoing response headers (see runbook).
 * @param {string} privateKey
 * @param {number} ttlSeconds
 * @param {(allowed: boolean, status: number) => unknown} respond
 */
export function create_content_bypass(privateKey, ttlSeconds = TTL_SECONDS, respond = edge_bypass_response, authorize) {
  /** @param {Request} request */
  return async function bypass(request) {
    trace_bypass(request, 'entered')
    const result = authorize_content_request(privateKey, ttlSeconds, request)
    // Native rules must see exactly the parameter names/encoding produced by
    // our signer; reject alternate encodings rather than rely on parser parity.
    let status = result.url && result.url.search.slice(1) !== result.url.searchParams.toString() ? 403 : result.status
    if (status === 200) {
      try {
        status = authorize ? await authorize(request) : 503
      }
      catch { status = 503 }
    }
    const allowed = status === 200
    trace_bypass(request, 'decision', allowed, status)
    const response = respond(allowed, status)
    trace_bypass(request, 'returned', allowed, status)
    return response
  }
}
export default {
  async bypass(request) {
    // ESA encrypted function variable; never embed the shared signing key.
    const { env } = await import('alibaba:workers')
    return create_content_bypass(env.ALIYUN_ESA_AUTH_KEY, TTL_SECONDS, edge_bypass_response,
      create_content_authorizer(env.ALIYUN_ESA_AUTH_KEY, env.CONTENT_AUTH_URL, Number(env.CONTENT_AUTH_TIMEOUT_MS ?? 5000)))(request)
  },
}
