export function useStaticUrl() {
  const base = useRuntimeConfig().public.oss.buckets.public.publicBaseUrl.replace(/\/+$/, '')

  return (path: string | null) => ! path ? '' : /^\/api\/content\/(?:private-attachments|attachments)\//.test(path) ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`
}
