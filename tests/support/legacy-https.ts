import { execFileSync } from 'node:child_process'
import { request } from 'node:http'
import { createServer } from 'node:https'

let certificate: Buffer | undefined

// Historical engines reject Secure cookies on HTTP localhost. Terminate TLS
// only at this loopback test boundary; keep the app's real cookie attributes.
function local_certificate() {
  certificate ??= Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $legacy_rsa = [System.Security.Cryptography.RSACng]::new(2048)
    try {
      $legacy_request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $legacy_rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
      $legacy_san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
      $legacy_san.AddDnsName('localhost')
      $legacy_request.CertificateExtensions.Add($legacy_san.Build())
      $legacy_cert = $legacy_request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(1))
      try { $legacy_encoded = [Convert]::ToBase64String($legacy_cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, '')) }
      finally { $legacy_cert.Dispose() }
    }
    finally { $legacy_rsa.Dispose() }
    [Console]::Out.Write($legacy_encoded)
  `], { windowsHide: true, encoding: 'utf8' }), 'base64')
  return certificate
}

export async function legacy_https(origin: string) {
  const target = new URL(origin)
  if (target.protocol !== 'http:' || target.hostname !== 'localhost')
    throw new Error('Legacy HTTPS fixture only forwards the isolated HTTP localhost server')
  const server = createServer({ pfx: local_certificate() }, (incoming, response) => {
    const url = new URL(incoming.url ?? '/', target)
    if (url.origin !== target.origin) {
      response.writeHead(400).end('Legacy HTTPS fixture only forwards its declared upstream')
      return
    }
    const upstream = request(url, {
      method: incoming.method,
      headers: { ... incoming.headers, 'x-forwarded-proto': 'https' },
    }, (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers)
      result.pipe(response)
    })
    upstream.on('error', () => {
      if (! response.headersSent)
        response.writeHead(502)
      response.end('Legacy HTTPS fixture upstream unavailable')
    })
    incoming.on('aborted', () => upstream.destroy())
    incoming.pipe(upstream)
  })
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(0, 'localhost', accept)
  })
  const address = server.address()
  if (! address || typeof address === 'string')
    throw new Error('Legacy HTTPS fixture did not bind a loopback port')
  return {
    target: target.origin,
    origin: `https://localhost:${address.port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()))
    },
  }
}
