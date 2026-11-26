export default defineEventHandler((event) => {
  const { hostname } = getRequestURL(event)
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    throw createError({ statusCode: 404 })
  }

  setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseHeader(event, 'Content-Security-Policy', 'default-src \'none\'; frame-src https://localhost:3477; style-src \'unsafe-inline\'; frame-ancestors \'none\'')
  const scene = getQuery(event).findings === 'paginated' ? '?findings=paginated' : ''

  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>运行状态预览</title>
<style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style>
<iframe src="https://localhost:3477/${scene}" title="运行状态预览"></iframe>
</html>`
})
