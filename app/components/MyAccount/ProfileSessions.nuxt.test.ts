import type { SessionOverview } from '@shared/types/session'
import type { Profile } from '@shared/types/user'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import ProfileSessions from './ProfileSessions.vue'

const { mock_sessions } = vi.hoisted(() => ({ mock_sessions: vi.fn() }))
vi.mock('~/features/account/profile', () => ({ useAccountSessions: () => mock_sessions() }))

async function mount_sessions(initial: SessionOverview | null, failed = false) {
  const sessions = ref(initial)
  const active = ref(true)
  const loading = ref(false)
  const load_failed = ref(failed)
  const refresh = vi.fn(async () => {
    loading.value = true
  })
  mock_sessions.mockReturnValue({ sessions, active, loading, load_failed, pending_id: ref(null), ready: Promise.resolve(), refresh, force_logout: vi.fn() })
  const wrapper = await mountSuspended(ProfileSessions, {
    props: { profile: { id: 7, editable: false, sensitive_readable: true } as Profile, isViewingOther: true },
    global: { stubs: { MyHeightSection: { template: '<section><slot /></section>' }, MyIcon: true } },
  })
  return { wrapper, sessions, active, loading, load_failed, refresh }
}

it('offers reload after the first failure and only shows the empty state after a successful response', async () => {
  const { wrapper, sessions, loading, load_failed, refresh } = await mount_sessions(null, true)
  try {
    expect(wrapper.text()).not.toContain('？！暂无记录！？')
    await wrapper.get('button[aria-label="重新加载"]').trigger('click')
    expect(refresh).toHaveBeenCalledOnce()
    expect(wrapper.find('[role="status"][aria-label="正在加载登录记录"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="重新加载"]').exists()).toBe(false)

    sessions.value = { records: [] }
    loading.value = false
    load_failed.value = false
    await nextTick()
    expect(wrapper.text()).toContain('？！暂无记录！？')
    expect(wrapper.find('button[aria-label="重新加载"]').exists()).toBe(false)
  }
  finally {
    wrapper.unmount()
  }
})

it('keeps readable sessions on a background failure and hides them after access is lost', async () => {
  const { wrapper, active } = await mount_sessions({ records: [{
    id: 1, identity_token: null, is_logged_out: false, is_expired: false, is_online: true,
    login_at: '2026-01-01T00:00:00.000Z', last_seen_at: '2026-01-01T01:00:00.000Z', logout_at: null,
    expires_at: '2027-01-01T00:00:00.000Z', login_ip: '192.0.2.1', last_seen_ip: null, user_agent: null, is_current: false,
  }] }, true)
  try {
    expect(wrapper.text()).toContain('192.0.2.1')
    expect(wrapper.text()).not.toContain('强制退出')
    expect(wrapper.find('button[aria-label="重新加载"]').exists()).toBe(false)

    active.value = false
    await nextTick()
    expect(wrapper.text()).not.toContain('192.0.2.1')
  }
  finally {
    wrapper.unmount()
  }
})
