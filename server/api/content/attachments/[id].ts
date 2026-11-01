import { ApiError } from '@server/errors/ApiError'
import { require_auth_user } from '@server/services/auth-guards.service'
import { attachment_redirect } from '@server/services/content/attachment-access.service'
import { createError, defineEventHandler, getHeader, getMethod, getQuery, getRouterParam, sendRedirect, setResponseHeader } from 'h3'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  setResponseHeader(event, 'Vary', 'Cookie, Accept')
  const method = getMethod(event)
  if (method !== 'GET' && method !== 'HEAD') {
    setResponseHeader(event, 'Allow', 'GET, HEAD')
    throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
  }
  const id = Number(getRouterParam(event, 'id'))
  if (! Number.isSafeInteger(id) || id <= 0)
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  const version = getQuery(event).version
  if (typeof version !== 'string' || ! version)
    throw createError({ statusCode: 400, statusMessage: 'Missing attachment version' })
  let viewer = null
  try {
    viewer = await require_auth_user(event)
  }
  catch (error) {
    if (! (error instanceof ApiError) || error.statusCode !== 401)
      throw error
  }
  const role = getQuery(event).role ?? 'auto'
  if (! ['auto', 'display', 'fallback', 'original', 'redacted_display', 'redacted_fallback', 'redacted'].includes(String(role)))
    throw createError({ statusCode: 400, statusMessage: 'Invalid image role' })
  return sendRedirect(event, await attachment_redirect(id, version, viewer, method, role as 'auto' | 'display' | 'fallback' | 'original' | 'redacted_display' | 'redacted_fallback' | 'redacted', getHeader(event, 'accept') ?? ''), 302)
})
