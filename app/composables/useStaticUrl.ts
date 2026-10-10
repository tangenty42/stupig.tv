export function useStaticUrl() {
  const base = useRuntimeConfig().public.site.staticBaseUrl

  return (path: string) => `${base}${path.startsWith('/') ? '' : '/'}${path}`
}
