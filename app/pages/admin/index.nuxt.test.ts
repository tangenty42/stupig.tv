import type { PermissionGrant } from '@shared/permissions'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { settings } from '@shared/settings'
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useRouter } from '#imports'
import AdminPage from './index.vue'

// The route middleware of /admin runs on the real router; let it through as an administrator.
const readonly_grant: PermissionGrant = { field: 'admin_access', level: 'readonly' }
const viewer = ref({ id: 7, is_admin: true, permissions: [] as PermissionGrant[] })
mockNuxtImport('useAuth', () => () => ({ user: viewer }))

const wrappers: { unmount: () => void }[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  viewer.value = { id: 7, is_admin: true, permissions: [] }
})

async function open(route: string) {
  const view = (name: string, time: Date | null) => ({
    props: ['focusStorage'],
    setup: () => ({ time, name }),
    template: '<div :data-view="name" :data-storage="focusStorage"><slot name="header" :updated_at="time" /></div>',
  })
  const wrapper = await mountSuspended(AdminPage, { route, global: { stubs: {
    MyAdminUsersView: view('users', new Date('2026-11-20T08:30:12Z')),
    MyAdminRunView: view('status', null),
    MyIcon: { props: ['name'], template: '<span :data-icon="name" />' },
  } } })
  wrappers.push(wrapper)
  return wrapper
}

const mounted_views = (wrapper: Awaited<ReturnType<typeof open>>) => wrapper.findAll('[data-view]').map(view => view.attributes('data-view'))

it.each([
  ['/admin', 'users'],
  ['/admin?view=status', 'status'],
  ['/admin?view=tasks', 'status'],
  ['/admin?view=storage', 'status'],
  ['/admin?view=unknown', 'users'],
])('mounts only the view the address names: %s', async (route, view) => {
  const wrapper = await open(route)
  expect(mounted_views(wrapper)).toEqual([view])
  if (view === 'status')
    expect(wrapper.get('[data-storage]').attributes('data-storage')).toBe(String(route.endsWith('=storage')))
  const interval = view === 'users' ? settings.app.admin.pollIntervalSeconds : settings.app.admin.statusPollIntervalSeconds
  expect(wrapper.get('header h1').text()).toBe(view === 'users' ? '用户管理' : '运行状态')
  expect(wrapper.get('header p').text()).toMatch(new RegExp(`每 ${interval} 秒自动更新`))
  if (view === 'users') {
    expect(wrapper.get('header time').attributes('datetime')).toBe('2026-11-20T08:30:12.000Z')
    expect(wrapper.get('header p').text()).toMatch(/前\s*更新/)
  }
  else {
    expect(wrapper.get('header p').text()).toContain('更新—')
  }
})

it('writes the chosen view into the address, keeps other parameters, and drops the parameter for the user list', async () => {
  const wrapper = await open('/admin?keep=1')
  const router = useRouter()
  const option = (label: string) => wrapper.findAll('[aria-label="控制台视图"] button').find(button => button.text() === label)!

  await option('运行状态').trigger('click')
  await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ keep: '1', view: 'status' }))
  await flushPromises()
  expect(mounted_views(wrapper)).toEqual(['status'])
  expect(wrapper.find('header time').exists()).toBe(false)

  await option('用户').trigger('click')
  await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ keep: '1' }))
  await flushPromises()
  expect(mounted_views(wrapper)).toEqual(['users'])
  expect(wrapper.get('header time').attributes('datetime')).toBe('2026-11-20T08:30:12.000Z')
})

it('keeps the console on downgrade to read-only and leaves it when the final grant disappears', async () => {
  const wrapper = await open('/admin')
  const router = useRouter()
  viewer.value = { id: 7, is_admin: false, permissions: [readonly_grant] }
  await flushPromises()
  expect(mounted_views(wrapper)).toEqual(['users'])
  expect(router.currentRoute.value.path).toBe('/admin')

  viewer.value.permissions = []
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'))
  expect(mounted_views(wrapper)).toEqual([])
})
