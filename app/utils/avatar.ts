export function avatar_url(static_url: (path: string) => string, file: string | null, version: string | null = null) {
  // `?version=` (the object ETag) busts the immutable cache when a new avatar
  // overwrites the same fixed object key; legacy token-named files pass null.
  return file ? `${static_url(`/avatar/${file}`)}${version ? `?version=${version}` : ''}` : null
}
