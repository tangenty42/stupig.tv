/** RFC 5987 filename override for storage responses, including non-ASCII names. */
export function content_disposition(file_name: string, disposition: 'attachment' | 'inline' = 'attachment') {
  const encoded = encodeURIComponent(file_name).replace(/['()*!]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${disposition}; filename*=UTF-8''${encoded}`
}
