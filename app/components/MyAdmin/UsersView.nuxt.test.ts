import type { PermissionGrant } from '@shared/permissions'
import type { AdminUser, AdminUserList } from '@shared/types/user'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { ADMIN_COMMANDS, ADMIN_FILTER_KEYWORDS } from '@shared/admin-command'
import { ADMIN_FILTER_FIELDS } from '@shared/types/user'
import { flushPromises } from '@vue/test-utils'
import AutoComplete from 'primevue/autocomplete'
import Paginator from 'primevue/paginator'
import { afterEach, expect, it, vi } from 'vitest'
import { h, ref } from 'vue'
import { TrpcApiError } from '~/composables/useTrpcClient'
import MyHeightTransition from '../MyHeightTransition.vue'
import UserCard from './UserCard.vue'
import UsersView from './UsersView.vue'

const boundary = vi.hoisted(() => ({ list_users: vi.fn(), set_admin_role: vi.fn(), ok: vi.fn(), error: vi.fn(), grouped_error: vi.fn() }))
const readonly_grant: PermissionGrant = { field: 'admin_access', level: 'readonly' }
const viewer = ref({ id: 7, is_admin: false, permissions: [readonly_grant] })
mockNuxtImport('useApi', () => () => ({ admin: boundary }))
mockNuxtImport('useAuth', () => () => ({ user: viewer }))
mockNuxtImport('useMyToast', () => () => ({ ok: boundary.ok, error: boundary.error, grouped_error: boundary.grouped_error }))
mockNuxtImport('useDataSync', () => () => ({ subscribe: () => () => {} }))

const wrappers: { unmount: () => void }[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.clearAllMocks()
})

async function open(is_admin: boolean, others: Partial<AdminUser>[] = []) {
  viewer.value = { id: 7, is_admin, permissions: is_admin ? [] : [readonly_grant] }
  const user: AdminUser = {
    id: 8, username: '小猪', is_admin: true, is_verified: false, is_banned: false, is_online: false,
    phone: null, avatar_file: null, avatar_version: null, permissions: [], verified_note: null,
    created_at: '2026-11-01T00:00:00Z', last_login_at: null, last_online_at: null,
  }
  const users = [user, ... others.map(other => ({ ... user, ... other }))]
  boundary.list_users.mockResolvedValue({ total: users.length, users })
  const wrapper = await mountSuspended(UsersView, {
    slots: { header: ({ updated_at }: { updated_at: Date | null }) => h('time', { datetime: updated_at?.toISOString() }) },
    global: { stubs: {
      MyAvatar: true,
      MyDialog: { props: ['visible', 'header'], template: '<div v-if="visible" role="dialog" :aria-label="header"><slot /><slot name="footer" /></div>' },
      MyIcon: true,
    } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

it('lets a read-only viewer filter users and explains a typed management command', async () => {
  const wrapper = await open(false)
  const input = wrapper.get('input[role="combobox"]')
  expect(input.attributes('placeholder')).toContain('筛选条件')
  expect(input.attributes('placeholder')).not.toContain('命令')
  expect(wrapper.find('button[aria-label="全选本页"]').exists()).toBe(false)
  expect(wrapper.get('.admin-user-card').find('button').exists()).toBe(false)
  const suggestions = wrapper.getComponent(AutoComplete)
  suggestions.vm.$emit('complete', { originalEvent: new Event('focus'), query: '' })
  await vi.waitFor(() => expect(suggestions.props('suggestions')).toEqual([... ADMIN_FILTER_FIELDS, ... ADMIN_FILTER_KEYWORDS]))

  await input.setValue('demote')
  await wrapper.get('button[aria-label="应用筛选条件"]').trigger('click')
  expect(wrapper.get('.form-error').text()).toContain('只有管理员')
  expect(boundary.set_admin_role).not.toHaveBeenCalled()

  await input.setValue('id = 8')
  await wrapper.get('button[aria-label="应用筛选条件"]').trigger('click')
  await flushPromises()
  expect(boundary.list_users).toHaveBeenLastCalledWith({ page: 1, page_size: 10, filter: 'id = 8' })
  expect(wrapper.find('.form-error').exists()).toBe(false)
})

it('names the action target and enables the batch action only after a user is selected', async () => {
  const wrapper = await open(true)
  const card = wrapper.get('.admin-user-card')
  expect(card.get('a[href="/u/8"]').text()).toBe('编辑资料')
  expect(card.find('button[aria-label="撤销管理员身份"]').exists()).toBe(true)
  const demote = wrapper.get('[aria-label="批量操作"]').get('button[aria-label="撤销管理员身份"]')
  expect(demote.attributes('disabled')).toBeDefined()

  await wrapper.get('input[role="combobox"]').setValue('DEMOTE')
  await wrapper.get('button[aria-label="执行筛选或命令"]').trigger('click')
  expect(wrapper.get('.form-error').text()).toContain('请先点选')
  await card.trigger('click')
  const sections = wrapper.findAll('section[aria-labelledby]')
  expect(sections[0]!.find('button[aria-label^="取消选择（"]').exists()).toBe(false)
  expect(wrapper.findAll('button[aria-label^="取消选择（"]')).toHaveLength(1)
  const clear_selection = sections[1]!.get('button[aria-label="取消选择（1）"]')
  expect(clear_selection.text()).toBe('取消选择（1）')
  expect(demote.attributes('disabled')).toBeUndefined()
  await clear_selection.trigger('click')
  expect(demote.attributes('disabled')).toBeDefined()
  expect(wrapper.get<HTMLInputElement>('input[role="combobox"]').element.value).toBe('DEMOTE')
  await card.trigger('click')
  expect(demote.attributes('disabled')).toBeUndefined()
  await wrapper.get('button[aria-label="执行筛选或命令"]').trigger('click')
  await flushPromises()
  expect(boundary.set_admin_role).toHaveBeenCalledExactlyOnceWith(8, false)
  expect(boundary.ok).toHaveBeenCalledExactlyOnceWith({ before: '撤销管理员身份：', badge: '小猪', after: '' })
  expect(wrapper.find('.form-error').exists()).toBe(false)
  expect(demote.attributes('disabled')).toBeDefined()
})

it('summarizes batch verification with the first user badge and the total', async () => {
  const wrapper = await open(true, [{ id: 9, username: '另一只小猪' }])
  const batch = wrapper.get('[aria-label="批量操作"]')
  await batch.get('button[aria-label="全选本页"]').trigger('click')
  await batch.get('button[aria-label="授予认证"]').trigger('click')
  const dialog = wrapper.get('[role="dialog"][aria-label="认证说明"]')
  const username = dialog.get('.badge-info-outlined')
  expect(username.text()).toBe('小猪')
  expect(username.element.parentElement?.textContent?.trim()).toBe('为小猪等，共 2 名用户')
  expect(dialog.text()).not.toContain('另一只小猪')
})

it('offers all local suggestions and lets ALL toggle the current page without a mutation', async () => {
  const wrapper = await open(true, [{ id: 9, username: '另一只小猪', is_admin: false }])
  const suggestions = wrapper.getComponent(AutoComplete)
  suggestions.vm.$emit('complete', { originalEvent: new Event('focus'), query: '' })
  await vi.waitFor(() => expect(suggestions.props('suggestions')).toEqual([... ADMIN_FILTER_FIELDS, ... ADMIN_FILTER_KEYWORDS, ... ADMIN_COMMANDS]))

  const input = wrapper.get('input[role="combobox"]')
  const execute = wrapper.get('button[aria-label="执行筛选或命令"]')
  const cards = wrapper.findAllComponents(UserCard)
  await input.setValue('all')
  await execute.trigger('click')
  expect(cards.map(card => card.props('selected'))).toEqual([true, true])
  await input.setValue('ALL')
  await execute.trigger('click')
  expect(cards.map(card => card.props('selected'))).toEqual([false, false])
  expect(boundary.list_users).toHaveBeenCalledTimes(1)
  expect(boundary.set_admin_role).not.toHaveBeenCalled()
})

it('groups the command and list controls and keeps each selectable result in its own animated card', async () => {
  const wrapper = await open(true, [{ id: 9, username: '另一只小猪', is_admin: false }])
  expect(Number.isFinite(Date.parse(wrapper.get('time').attributes('datetime')!))).toBe(true)
  const sections = wrapper.findAll('section[aria-labelledby]')
  expect(sections.map(section => section.get('h2').text())).toEqual(['命令', '用户列表'])
  expect(sections[0]!.get('.p-card').find('input[role="combobox"]').exists()).toBe(true)
  const controls = sections[1]!.get('.p-card')
  expect(controls.find('[aria-label="批量操作"]').exists()).toBe(true)
  expect(controls.find('nav[aria-label="用户列表分页"]').exists()).toBe(true)
  expect(controls.find('.admin-user-card').exists()).toBe(false)

  const list = sections[1]!.get('[role="list"][aria-label="用户卡片"]')
  const cards = wrapper.findAllComponents(UserCard)
  expect(cards.every(card => list.element.contains(card.element))).toBe(true)
  expect(list.element.closest('.my-height-transition')?.parentElement).toBe(sections[1]!.element)
  expect(cards.map(card => card.props('user').id)).toEqual([8, 9])
  expect(cards.map(card => card.findAllComponents(MyHeightTransition).length)).toEqual([1, 1])
  await cards[1]!.get('button[aria-label="修改权限"]').trigger('click')
  expect(cards[1]!.emitted('edit-permissions')).toHaveLength(1)
  expect(cards[1]!.emitted('toggle-select')).toBeUndefined()
  await cards[1]!.trigger('click')
  expect(cards.map(card => card.props('selected'))).toEqual([false, true])

  boundary.list_users.mockResolvedValue({ total: 0, users: [] })
  await controls.get('button[aria-label="刷新"]').trigger('click')
  await flushPromises()
  expect(controls.get('[role="status"]').text()).toContain('没有匹配的用户')
  expect(controls.find('button[aria-label^="取消选择（"]').exists()).toBe(false)
  expect(wrapper.findComponent(UserCard).exists()).toBe(false)
})

it('drops previous targets immediately on a page or filter change, including after a failed or late response', async () => {
  const wrapper = await open(true)
  const card = wrapper.getComponent(UserCard)
  const first_user = card.props('user')
  await card.trigger('click')
  await card.get('button[aria-label="授予认证"]').trigger('click')
  expect(wrapper.get('[role="dialog"]').text()).toContain(`用户『${first_user.username}』`)

  const late_page = Promise.withResolvers<AdminUserList>()
  boundary.list_users.mockReturnValueOnce(late_page.promise)
  wrapper.getComponent(Paginator).vm.$emit('page', { first: 10, rows: 10 })
  await flushPromises()
  expect(boundary.list_users).toHaveBeenLastCalledWith({ page: 2, page_size: 10, filter: undefined })
  expect(wrapper.findComponent(UserCard).exists()).toBe(false)
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  expect(wrapper.get('[aria-label="批量操作"] [aria-label="撤销管理员身份"]').attributes('disabled')).toBeDefined()

  boundary.list_users.mockRejectedValueOnce(new Error('offline'))
  const input = wrapper.get('input[role="combobox"]')
  const execute = wrapper.get('button[aria-label="执行筛选或命令"]')
  await input.setValue('id = 9')
  await execute.trigger('click')
  await flushPromises()
  late_page.resolve({ users: [first_user], total: 11 })
  await flushPromises()
  expect(wrapper.text()).toContain('用户列表读取失败')
  expect(wrapper.findComponent(UserCard).exists()).toBe(false)
  await input.setValue('DEMOTE')
  await execute.trigger('click')
  expect(wrapper.get('.form-error').text()).toContain('请先点选')
  expect(boundary.set_admin_role).not.toHaveBeenCalled()

  boundary.list_users.mockResolvedValueOnce({ total: 1, users: [{ ... first_user, id: 9, username: '另一只猪' }] })
  await wrapper.get('button[aria-label="刷新"]').trigger('click')
  await flushPromises()
  const new_card = wrapper.getComponent(UserCard)
  expect(new_card.props('user').id).toBe(9)
  expect(new_card.props('selected')).toBe(false)
})

it('clears open management controls on downgrade and the list itself on a denied refresh', async () => {
  const wrapper = await open(true, [{ id: 9, username: '另一只猪', phone: '13000000009', is_admin: false }])
  const card = wrapper.findAllComponents(UserCard)[1]!
  await card.trigger('click')
  await card.get('button[aria-label="修改权限"]').trigger('click')
  expect(wrapper.get('[role="dialog"] .badge-info-outlined').text()).toBe('另一只猪')

  viewer.value = { id: 7, is_admin: false, permissions: [readonly_grant] }
  await flushPromises()
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  expect(wrapper.find('[aria-label="批量操作"]').exists()).toBe(false)
  expect(card.props('selected')).toBe(false)
  expect(card.text()).toContain('13000000009')
  await card.trigger('click')
  expect(card.props('selected')).toBe(true)

  boundary.list_users.mockRejectedValueOnce({ data: { httpStatus: 403 } })
  await wrapper.get('button[aria-label="刷新"]').trigger('click')
  await flushPromises()
  expect(wrapper.emitted('access-denied')).toHaveLength(1)
  expect(wrapper.findComponent(UserCard).exists()).toBe(false)
  expect(wrapper.text()).not.toContain('13000000009')
  expect(wrapper.get('time').attributes('datetime')).toBeUndefined()
})

it('uses the same set-admin wording in the action and its success toast', async () => {
  const wrapper = await open(true, [{ id: 9, username: '小明', is_admin: false }])
  boundary.set_admin_role.mockResolvedValue(undefined)
  const card = wrapper.findAllComponents(UserCard).find(item => item.props('user').id === 9)!
  await card.get('button[aria-label="设为管理员"]').trigger('click')
  await flushPromises()
  expect(boundary.set_admin_role).toHaveBeenCalledExactlyOnceWith(9, true)
  expect(boundary.ok).toHaveBeenCalledExactlyOnceWith({ before: '设为管理员：', badge: '小明', after: '' })
})

it('continues confirmed pre-write rejections in order and groups each reason with its first target and count', async () => {
  const wrapper = await open(true, [
    { id: 9, username: '小明' },
    { id: 10, username: '小红' },
    { id: 11, username: '小蓝' },
    { id: 12, username: '小绿' },
  ])
  const first_request = Promise.withResolvers<void>()
  boundary.set_admin_role
    .mockReturnValueOnce(first_request.promise)
    .mockRejectedValueOnce(new TrpcApiError('小明：不能修改该用户', 400, { code: 'ADMIN_TARGET_REJECTED' }))
    .mockRejectedValueOnce(new TrpcApiError('用户不存在', 404, { code: 'ADMIN_TARGET_REJECTED' }))
    .mockRejectedValueOnce(new TrpcApiError('小蓝: 不能修改该用户', 400, { code: 'ADMIN_TARGET_REJECTED' }))
    .mockResolvedValueOnce(undefined)
  const batch = wrapper.get('[aria-label="批量操作"]')
  await batch.get('[aria-label="全选本页"]').trigger('click')
  await batch.get('[aria-label="撤销管理员身份"]').trigger('click')
  await flushPromises()
  expect(boundary.set_admin_role.mock.calls).toEqual([[8, false]])
  first_request.resolve()
  await flushPromises()
  expect(boundary.set_admin_role.mock.calls).toEqual([[8, false], [9, false], [10, false], [11, false], [12, false]])
  expect(boundary.grouped_error).toHaveBeenCalledExactlyOnceWith([
    { before: '', badge: '小明', after: '等 2 个用户：不能修改该用户' },
    { before: '', badge: '小红', after: '：用户不存在' },
  ])
  expect(boundary.error).not.toHaveBeenCalled()
  expect(boundary.ok).not.toHaveBeenCalled()
  expect(boundary.list_users).toHaveBeenCalledTimes(2)
})

it.each([
  { label: 'plain failure', status: undefined, marked: false },
  { label: 'unmarked business rejection', status: 400, marked: false },
  { label: 'unknown transport result', status: undefined, marked: true },
  { label: 'server failure', status: 500, marked: true },
  { label: 'permission denial', status: 403, marked: true },
  { label: 'unauthorized session', status: 401, marked: true },
])('stops at $label without trying later targets or treating the unknown result as a confirmed rejection', async ({ status, marked }) => {
  const wrapper = await open(true, [{ id: 9, username: '小明' }, { id: 10, username: '小红' }])
  const failure = new TrpcApiError('操作失败', status, marked ? { code: 'ADMIN_TARGET_REJECTED' } : undefined)
  boundary.set_admin_role
    .mockRejectedValueOnce(new TrpcApiError('不能修改该用户', 400, { code: 'ADMIN_TARGET_REJECTED' }))
    .mockRejectedValueOnce(failure)
  const batch = wrapper.get('[aria-label="批量操作"]')
  await batch.get('[aria-label="全选本页"]').trigger('click')
  await batch.get('[aria-label="撤销管理员身份"]').trigger('click')
  await flushPromises()
  expect(boundary.set_admin_role.mock.calls).toEqual([[8, false], [9, false]])
  if (status === 401) {
    expect(boundary.error).not.toHaveBeenCalled()
    expect(boundary.grouped_error).not.toHaveBeenCalled()
    expect(boundary.list_users).toHaveBeenCalledTimes(1)
  }
  else {
    expect(boundary.error).toHaveBeenCalledExactlyOnceWith(failure)
    expect(boundary.grouped_error).toHaveBeenCalledExactlyOnceWith([{ before: '', badge: '小猪', after: '：不能修改该用户' }])
    expect(boundary.list_users).toHaveBeenCalledTimes(2)
  }
  expect(boundary.ok).not.toHaveBeenCalled()
})

it.each(['page', 'filter', 'downgrade', 'account', 'unmount'] as const)('stops the old batch after a pending response if its %s changes', async (change) => {
  const wrapper = await open(true, [{ id: 9, username: '小明' }])
  const pending = Promise.withResolvers<void>()
  boundary.set_admin_role.mockReturnValueOnce(pending.promise)
  const batch = wrapper.get('[aria-label="批量操作"]')
  await batch.get('[aria-label="全选本页"]').trigger('click')
  await batch.get('[aria-label="撤销管理员身份"]').trigger('click')
  await flushPromises()
  expect(boundary.set_admin_role).toHaveBeenCalledExactlyOnceWith(8, false)

  if (change === 'page') {
    wrapper.getComponent(Paginator).vm.$emit('page', { first: 10, rows: 10 })
  }
  else if (change === 'filter') {
    await wrapper.get('input[role="combobox"]').setValue('id = 9')
    await wrapper.get('button[aria-label="执行筛选或命令"]').trigger('click')
  }
  else if (change === 'downgrade') {
    viewer.value = { id: 7, is_admin: false, permissions: [readonly_grant] }
  }
  else if (change === 'account') {
    viewer.value = { id: 70, is_admin: true, permissions: [] }
  }
  else {
    wrapper.unmount()
    wrappers.splice(wrappers.indexOf(wrapper), 1)
  }
  await flushPromises()
  const refresh_count = boundary.list_users.mock.calls.length
  if (change === 'page')
    pending.resolve()
  else
    pending.reject(new TrpcApiError('用户不存在', 404, { code: 'ADMIN_TARGET_REJECTED' }))
  await flushPromises()
  expect(boundary.set_admin_role).toHaveBeenCalledExactlyOnceWith(8, false)
  expect(boundary.list_users).toHaveBeenCalledTimes(refresh_count)
  expect(boundary.grouped_error).not.toHaveBeenCalled()
  expect(boundary.error).not.toHaveBeenCalled()
  expect(boundary.ok).not.toHaveBeenCalled()
})

it.each([false, true])('keeps a single-user error unchanged, including a marked rejection: %s', async (marked) => {
  const wrapper = await open(true)
  const failure = marked ? new TrpcApiError('用户不存在', 404, { code: 'ADMIN_TARGET_REJECTED' }) : new Error('用户不存在')
  boundary.set_admin_role.mockRejectedValueOnce(failure)
  await wrapper.getComponent(UserCard).get('button[aria-label="撤销管理员身份"]').trigger('click')
  await flushPromises()
  expect(boundary.set_admin_role).toHaveBeenCalledExactlyOnceWith(8, false)
  expect(boundary.error).toHaveBeenCalledExactlyOnceWith(failure)
  expect(boundary.grouped_error).not.toHaveBeenCalled()
})
