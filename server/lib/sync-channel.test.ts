import { describe, expect, it, vi } from 'vitest'

vi.mock('@config/loader', () => ({
  runtime_config: () => ({ app: { auth: { jwt: { secret: 'unit-test-channel-secret-with-enough-length' } } } }),
}))

const { otp_cooldown_channels, wire_resource } = await import('./sync-channel')

describe('wire_resource', () => {
  it('passes non-sensitive resources through unchanged', () => {
    expect(wire_resource('profile:7')).toBe('profile:7')
    expect(wire_resource('content_stories:0')).toBe('content_stories:0')
  })

  it('passes malformed and wildcard-shaped strings through', () => {
    expect(wire_resource('otp_cooldown*')).toBe('otp_cooldown*')
    expect(wire_resource('')).toBe('')
  })

  it('issues versioned keyed channels instead of the personal identifier', () => {
    expect(wire_resource('otp_cooldown:13800138000')).toMatch(/^otp_cooldown:v1\.[\w-]{22}$/)
    expect(wire_resource('otp_cooldown:13800138000')).not.toContain('13800138000')
    expect(wire_resource('otp_cooldown_by_identity:0c9a1b2f-62c4-4df7-89e6-93f4a6a3c607')).not.toContain('0c9a1b2f')
  })

  it('derives stable, type-separated channels', () => {
    expect(wire_resource('otp_cooldown:13800138000')).toBe(wire_resource('otp_cooldown:13800138000'))
    expect(wire_resource('otp_cooldown:13800138000')).not.toBe(wire_resource('otp_cooldown_by_identity:13800138000'))
    expect(wire_resource('otp_cooldown:13800138000')).not.toBe(wire_resource('otp_cooldown:13800138001'))
  })
})

describe('otp_cooldown_channels', () => {
  it('returns both dimensions with a phone, identity-only without', () => {
    const with_phone = otp_cooldown_channels('13800138000', 'device-a')
    expect(with_phone.phone).toMatch(/^otp_cooldown:v1\./)
    expect(with_phone.identity).toMatch(/^otp_cooldown_by_identity:v1\./)

    const without_phone = otp_cooldown_channels(undefined, 'device-a')
    expect(without_phone.phone).toBeNull()
    expect(without_phone.identity).toMatch(/^otp_cooldown_by_identity:v1\./)
  })

  it('hands out exactly the channels the publish path mints', () => {
    // The query path and publish path must share one derivation; if they ever
    // diverge, subscribers would watch topics that never receive events.
    expect(otp_cooldown_channels('13800138000', 'device-a').phone).toBe(wire_resource('otp_cooldown:13800138000'))
    expect(otp_cooldown_channels('13800138000', 'device-a').identity).toBe(wire_resource('otp_cooldown_by_identity:device-a'))
  })
})
