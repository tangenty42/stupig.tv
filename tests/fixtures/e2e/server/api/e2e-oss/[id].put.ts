import { receive_part } from '../../../../../support/e2e-storage'

export default defineEventHandler(async (event) => {
  const bytes = await readRawBody(event, false)
  if (! bytes)
    throw createError({ statusCode: 400 })
  const etag = receive_part(getRouterParam(event, 'id')!, Number(getQuery(event).part), bytes)
  setHeader(event, 'ETag', `"${etag}"`)
  return ''
})
