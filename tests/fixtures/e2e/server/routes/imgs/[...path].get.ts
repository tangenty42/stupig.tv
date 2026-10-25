export default defineEventHandler((event) => {
  setHeader(event, 'Content-Type', 'image/svg+xml')
  return '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#ddd"/></svg>'
})
