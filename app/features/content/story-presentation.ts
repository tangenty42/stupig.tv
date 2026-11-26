export function visible_story_labels(labels: string[]) {
  return labels.filter(label => ! label.startsWith('#'))
}

export function story_rating_image_url(static_url: (path: string) => string, rank: number) {
  return static_url(`imgs/ratings/${6 - rank}.svg`)
}
