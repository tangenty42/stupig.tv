export default (url: string) => {
  if (import.meta.server) return
  
  try {
    const targetUrl = new URL(url, window.location.origin)
    
    window.open(targetUrl.toString(), '_blank')
  }
  catch {
    window.open(url, '_blank')
  }
}
