/** Extract a readable title without requiring a complete, publishable draft. */
export function draft_title(prefix: string, complete: boolean) {
  const lines = `${prefix}${complete ? '\n' : ''}`.split('\n')
  if (lines[0]?.trim() !== '---')
    return '未命名草稿'
  // The last line may have been cut off by the bounded database read.
  for (const line of lines.slice(1, - 1)) {
    if (line.trim() === '---')
      break
    if (! line.trim())
      continue
    const match = /^([A-Z_]\w*)\s*:(.*)$/i.exec(line)
    if (! match)
      break
    if (match[1] === 'title')
      return match[2]?.trim().slice(0, 120) || '未命名草稿'
  }
  return '未命名草稿'
}
