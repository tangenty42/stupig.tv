import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import MyAvatar from './MyAvatar.vue'

mockNuxtImport('useStaticUrl', () => () => (path: string) => path)

it('keeps initials after the current avatar fails and retries only when its URL changes', async () => {
  const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false)
  onTestFinished(() => complete.mockRestore())
  const user = { id: 1, username: 'Kai', avatar_file: '1.jpg', avatar_version: 'old' }
  const avatar = await mountSuspended(MyAvatar, { props: { user, lazy: true } })
  onTestFinished(() => avatar.unmount())
  const old_image = avatar.get('img')
  await old_image.trigger('error')
  expect(avatar.find('img').exists()).toBe(false)
  expect(avatar.text()).toBe('K')

  await avatar.setProps({ user: { ... user, username: 'Ren' } })
  expect(avatar.find('img').exists()).toBe(false)
  expect(avatar.text()).toBe('R')

  await avatar.setProps({ user: { ... user, avatar_version: 'new' } })
  expect(avatar.get('img').attributes('src')).toBe('/avatar/1.jpg?version=new')
  await old_image.trigger('error')
  expect(avatar.get('img').attributes('src')).toBe('/avatar/1.jpg?version=new')
})
