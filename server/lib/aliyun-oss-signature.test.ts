import { expect, it, vi } from 'vitest'

vi.mock('@config/loader', () => ({ runtime_config: () => ({ aliyun: { oss: null } }) }))
const { create_aliyun_oss } = await import('./aliyun-oss')

// Use the actual official SDK without network calls. Mocking its signer alone
// would miss V4 method support and key encoding (including incomplete TS types).
it.each([
  ['GET', 'attachment'], ['HEAD', 'attachment'], ['GET', 'inline'], ['HEAD', 'inline'],
] as const)('uses the real SDK to generate a current-version %s V4 URL with %s filename', async (method, disposition) => {
  const storage = create_aliyun_oss({
    region: 'oss-cn-hangzhou', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', bucket: 'fixture-bucket',
    publicBaseUrl: 'https://cdn.test', accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret',
    timeoutMs: 120_000, copyPartSizeMb: 64, uploadRoleArn: null,
  })
  const url = new URL(await storage.signed_read_url('content/att/a b', 3600, method, '文件 (1).txt', disposition))
  expect(url.protocol).toBe('https:')
  expect(url.hostname).toBe('fixture-bucket.oss-cn-hangzhou.aliyuncs.com')
  expect(decodeURIComponent(url.pathname)).toBe('/content/att/a b')
  expect(url.searchParams.get('x-oss-signature-version')).toBe('OSS4-HMAC-SHA256')
  expect(url.searchParams.get('x-oss-expires')).toBe('3600')
  expect(url.searchParams.get('x-oss-signature')).toMatch(/^[\da-f]{64}$/)
  expect(url.searchParams.get('response-content-disposition')).toBe(`${disposition}; filename*=UTF-8''%E6%96%87%E4%BB%B6%20%281%29.txt`)
  expect(url.searchParams.has('versionId')).toBe(false)
})

it('uses the official V4 signer for a part capability with signed length and MD5', async () => {
  const storage = create_aliyun_oss({
    region: 'oss-cn-hangzhou', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', bucket: 'fixture-bucket',
    publicBaseUrl: 'https://cdn.test', accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret',
    timeoutMs: 120_000, copyPartSizeMb: 64, uploadRoleArn: null,
  })
  const grant = await storage.signed_part_upload('content/att/a b', 'upload-id', 2, 12, '1B2M2Y8AsgTpgAmY7PhCfg==', 900)
  const url = new URL(grant.url)
  expect(url.protocol).toBe('https:')
  expect(url.searchParams.get('uploadId')).toBe('upload-id')
  expect(url.searchParams.get('partNumber')).toBe('2')
  expect(url.searchParams.get('x-oss-expires')).toBe('900')
  expect(url.searchParams.get('x-oss-additional-headers')).toBe('content-length')
  expect(url.searchParams.has('x-oss-security-token')).toBe(false)
  expect(grant.headers['Content-MD5']).toBe('1B2M2Y8AsgTpgAmY7PhCfg==')
  expect(grant.headers['Content-Length']).toBe('12')
  const other = await storage.signed_part_upload('content/att/a b', 'upload-id', 2, 13, '1B2M2Y8AsgTpgAmY7PhCfg==', 900)
  expect(new URL(other.url).searchParams.get('x-oss-signature')).not.toBe(url.searchParams.get('x-oss-signature'))
})
