export function useStaticUrl() {
  const base = useRuntimeConfig().public.static_base_url

  return (path: string) => `${base}${path.startsWith('/') ? '' : '/'}${path}`
}
