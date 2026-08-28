export function avatar_url(static_url: (path: string) => string, file: string | null) {
  return file ? static_url(`/avatar/${file}`) : null
}
