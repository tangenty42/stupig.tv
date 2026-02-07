export default (url: string) => {
  if (import.meta.server) return
  
  try {
    const targetUrl = new URL(url, window.location.origin)
    const isSameSite = targetUrl.origin === window.location.origin
    
    if (isSameSite)
      navigateTo(targetUrl.pathname + targetUrl.search + targetUrl.hash)
    else
      window.location.href = url
  }
  catch {
    navigateTo(url)
  }
}
