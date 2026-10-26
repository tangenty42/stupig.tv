import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ publish_sync: vi.fn() }))
vi.mock('@config/loader', () => ({
  runtime_config: () => ({ app: { auth: { jwt: { secret: 'unit-test-sync-secret-with-enough-length' } } } }),
}))
vi.mock('./mqtt', () => ({ publish_sync: mocks.publish_sync }))

const { publish_refresh } = await import('./sync')

afterEach(() => {
  mocks.publish_sync.mockClear()
})

describe('publish_refresh', () => {
  it('publishes non-sensitive resources verbatim', () => {
    publish_refresh({ resource: 'profile_sessions:7' })

    expect(mocks.publish_sync).toHaveBeenCalledWith('profile_sessions:7', expect.any(String))
  })

  it('puts only the keyed channel on the topic and in the payload', () => {
    publish_refresh({ resource: 'otp_cooldown:13800138000' })

    const [topic, payload] = mocks.publish_sync.mock.calls[0]!
    expect(topic).toMatch(/^otp_cooldown:v1\.[\w-]{22}$/)
    expect(JSON.parse(payload)).toMatchObject({ type: 'refresh', resource: topic })
    expect(`${topic}${payload}`).not.toContain('13800138000')
  })
})
