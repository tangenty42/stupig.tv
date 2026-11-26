import { expect, it, vi } from 'vitest'
import { createSSRApp, h, nextTick, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import Body from './Body.vue'

it('retains server media during hydration and subsequent live text patches', async () => {
  const initial = '<p>before</p><span class="img-frame"><img src="/ssr-image.png"><span class="image-lqip" aria-hidden="true"></span></span>'
  const container = document.createElement('div')
  container.innerHTML = await renderToString(createSSRApp({ render: () => h(Body, { html: initial }) }))
  document.body.append(container)
  const image = container.querySelector('img')!
  const layer = container.querySelector('.image-lqip')!
  const html = ref(initial)
  const clicked = vi.fn()
  const app = createSSRApp({ setup: () => () => h(Body, { html: html.value, onClick: clicked }) })
  try {
    app.mount(container)
    await nextTick()
    expect(container.querySelector('img')).toBe(image)
    expect(container.querySelector('.image-lqip')).toBe(layer)
    container.querySelector('p')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(clicked).toHaveBeenCalledOnce()
    html.value = initial.replace('before', 'after')
    await nextTick()
    expect(container.querySelector('p')?.textContent).toBe('after')
    expect(container.querySelector('img')).toBe(image)
    expect(container.querySelector('.image-lqip')).toBe(layer)
  }
  finally {
    app.unmount()
    container.remove()
  }
})
