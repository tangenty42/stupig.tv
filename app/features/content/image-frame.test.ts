import { expect, it } from 'vitest'
import { image_loading_mask, image_unavailable } from './image-frame'

it('shares image loading and failure markup while escaping context-specific labels', () => {
  expect(image_loading_mask('内容加载中')).toContain('<span class="sr-only">内容加载中</span>')
  expect(image_unavailable('封面加载失败')).toContain('aria-label="封面加载失败"')
  expect(image_unavailable('" onload="bad')).toContain('aria-label="&quot; onload=&quot;bad"')
})
