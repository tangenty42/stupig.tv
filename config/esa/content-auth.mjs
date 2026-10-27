/* global ResponseBypass: readonly */
import { Buffer } from 'node:buffer'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const TTL_SECONDS = 300
const CLOCK_SKEW_SECONDS = 30
const DEBUG_BUILD = 'content-bypass-debug-v1'

/**
 * `env` shape for the variables published by `pnpm esa:deploy:*`; a variable
 * missing from the deployed function reads as `undefined` and every entry point
 * below treats that as fail-closed, never as an empty usable value.
 * @typedef {import('./content-auth.d.mts').EsaFunctionVariables} EsaFunctionVariables
 */

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

/** @param {string | null} actual @param {string} expected */
function equal_signature(actual, expected) {
  return typeof actual === 'string' && /^[a-f\d]{64}$/.test(actual)
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

/** @param {string} privateKey @param {URL} url @param {string} issuedAt @param {string} expiresAt @param {string} nonce */
export function content_url_signature(privateKey, url, issuedAt, expiresAt, nonce) {
  return createHmac('sha256', privateKey).update(JSON.stringify([
    'content-url-v2', url.origin, url.pathname, ['GET', 'HEAD'], issuedAt, expiresAt, nonce,
    url.searchParams.get('response-content-disposition') ?? '', url.searchParams.get('access') ?? '',
  ])).digest('hex')
}

/** @param {string} privateKey @param {number} ttlSeconds @param {Request} request */
export function authorize_content_request(privateKey, ttlSeconds, request) {
  const deny = (status = 403) => ({ status, url: null, disposition: null })
  if (! privateKey || privateKey === 'REPLACE_WITH_RANDOM_SECRET')
    return deny(503)
  if (! Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) {
    return deny(503)
  }
  if (! ['GET', 'HEAD'].includes(request.method))
    return deny(405)
  const url = new URL(request.url)
  const headerName = 'response-content-disposition'
  if (url.username || url.password || url.hash || url.searchParams.getAll('auth_key').length !== 1
    || url.searchParams.getAll(headerName).length > 1
    || url.searchParams.getAll('access').length > 1
    || [... url.searchParams.keys()].some(key => ! ['auth_key', headerName, 'access'].includes(key))) {
    return deny()
  }
  const disposition = url.searchParams.get(headerName)
  const access = url.searchParams.get('access')
  if (disposition !== null && ! /^(?:attachment|inline); filename\*=UTF-8''(?:[\w.~-]|%[a-f\d]{2})+$/i.test(disposition))
    return deny()
  if (access !== null && ! /^[\w-]{1,2048}$/.test(access))
    return deny()
  const token = url.searchParams.get('auth_key') ?? ''
  const now = Math.floor(Date.now() / 1000)
  const current = /^v2-(\d{10})-(\d{10})-([a-f\d]{32})-([a-f\d]{64})$/.exec(token)
  if (! current)
    return deny()
  const [, issuedAt, expiresAt, nonce, signature] = current
  if (Number(issuedAt) > now + CLOCK_SKEW_SECONDS || now >= Number(expiresAt)
    || Number(expiresAt) <= Number(issuedAt) || Number(expiresAt) - Number(issuedAt) > ttlSeconds
    || ! equal_signature(signature, content_url_signature(privateKey, url, issuedAt, expiresAt, nonce))) {
    return deny()
  }
  return { status: 200, url, disposition }
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
      return response.status === 204 && equal_signature(proof, content_authorization_proof(privateKey, nonce, request.url, request.method)) ? 200 : 503
    }
    catch { return 503 }
    finally { clearTimeout(timer) }
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
    const { env } = /** @type {{ env: EsaFunctionVariables }} */ (await import('alibaba:workers'))
    return create_content_bypass(env.ALIYUN_ESA_AUTH_KEY, TTL_SECONDS, edge_bypass_response,
      create_content_authorizer(env.ALIYUN_ESA_AUTH_KEY, env.CONTENT_AUTH_URL, Number(env.CONTENT_AUTH_TIMEOUT_MS ?? 5000)))(request)
  },
}
