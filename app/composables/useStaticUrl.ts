export function useStaticUrl() {
  const base = useRuntimeConfig().public.oss.buckets.public.publicBaseUrl.replace(/\/+$/, '')

  return (path: string | null) => ! path ? '' : /^\/api\/links\/attachments\//.test(path) ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`
}
