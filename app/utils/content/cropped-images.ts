// Cropped-image detection for a rendered story body. The min-w/min-h/
// object-crop rule clips tall (and wide) images without leaving a marker in
// the DOM, so real clipping is detected from the rendered box vs the natural
// ratio and the frame tagged to reveal its "点击查看完整图片" cover.
// The rendered box changes with the viewport (window resize, the carousel's
// max-w-full clamp), so each framed image keeps a ResizeObserver instead of
// being measured once; the observer's initial fire doubles as the first
// measurement.

/**
    Tag cropped frames under the body. Returns a cleanup that disconnects the
   observer, or null when there are no framed images.
 */
export function observe_cropped_images(body: HTMLElement) {
  const images = body.querySelectorAll<HTMLImageElement>('.img-frame > img')
  if (! images.length) {
    return null
  }
  const update = (image: HTMLImageElement) => {
    if (! image.naturalWidth) {
      return
    }
    const frame = image.parentElement
    const ratio = image.naturalHeight / image.naturalWidth
    const cropped_tall = image.clientWidth * ratio - image.clientHeight > 1
    const cropped_wide = image.clientHeight / ratio - image.clientWidth > 1
    frame?.toggleAttribute('data-cropped', cropped_tall || cropped_wide)
    const cover = frame?.querySelector('.long-img-cover')
    if (cover) {
      cover.textContent = '点击查看完整图片'
    }
  }
  const observer = new ResizeObserver(entries =>
    entries.forEach(entry => update(entry.target as HTMLImageElement)))
  for (const image of images) {
    image.addEventListener('load', () => update(image), { once: true })
    observer.observe(image)
  }
  return () => observer.disconnect()
}
