export default defineEventHandler(async (event) => {
  const name = getQuery(event).name
  setHeader(event, 'Cache-Control', 'no-store')
  if (name === 'failed')
    throw createError({ statusCode: 404, statusMessage: 'Fixture image unavailable' })
  if (name === 'loading')
    await new Promise(resolve => setTimeout(resolve, 2500))
  setHeader(event, 'Content-Type', 'image/svg+xml')
  const color = name === 'two' ? '#0d9488' : name === 'three' ? '#7c3aed' : '#d97706'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="320"><rect width="800" height="320" fill="${color}"/><path d="M0 160H800M400 0V320" stroke="white" stroke-width="8"/></svg>`
})
