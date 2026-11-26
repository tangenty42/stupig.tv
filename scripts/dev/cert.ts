import { spawnSync } from 'node:child_process'
import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dev_https_ca_path } from './https'

const files = ['ca.pem', 'localhost.pem', 'localhost.key'] as const
type CertificateFiles = Record<(typeof files)[number], Buffer>
const development_ca_name = 'stupig-local-development'

function certificate_fingerprint(directory: string) {
  const ca = new X509Certificate(readFileSync(join(directory, 'ca.pem')))
  const cert = new X509Certificate(readFileSync(join(directory, 'localhost.pem')))
  const key = createPrivateKey(readFileSync(join(directory, 'localhost.key')))
  const valid_now = [ca, cert].every(item => Date.parse(item.validFrom) <= Date.now() && Date.now() < Date.parse(item.validTo))
  if (! valid_now || ! ca.ca || cert.ca || ! ca.checkIssued(ca) || ! ca.verify(ca.publicKey) || ! cert.checkIssued(ca) || ! cert.verify(ca.publicKey)
    || ! cert.checkPrivateKey(key) || ! cert.checkHost('localhost', { subject: 'never' }) || ! cert.checkIP('127.0.0.1') || ! cert.checkIP('::1')) {
    throw new Error('Invalid local development certificate chain or key')
  }
  return ca.fingerprint256
}

function generate_certificates(stage: string) {
  const git_openssl = join(process.env.ProgramFiles || 'C:/Program Files', 'Git/usr/bin/openssl.exe')
  const openssl = process.platform === 'win32' && existsSync(git_openssl) ? git_openssl : 'openssl'
  // The temporary signing key is encrypted. Its random passphrase only crosses stdin.
  const passphrase = randomBytes(48).toString('hex')
  const run = (args: string[]) => {
    const result = spawnSync(openssl, args, { cwd: stage, input: `${passphrase}\n`, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    if (result.error || result.status !== 0)
      throw new Error(`OpenSSL could not generate the development certificate (${result.error?.message ?? result.stderr.toString().trim()}). Install OpenSSL or Git for Windows and run pnpm dev:cert again`)
  }
  run([
    'req', '-new', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '398', '-subj', `/CN=Stupig Local Development ${randomBytes(4).toString('hex')}`,
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-passout', 'stdin', '-keyout', 'signing.key', '-out', 'ca.pem',
  ])
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=localhost', '-keyout', 'localhost.key', '-out', 'localhost.csr'])
  writeFileSync(join(stage, 'server.ext'), [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid,issuer',
    'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
  ].join('\n'))
  run([
    'x509', '-req', '-in', 'localhost.csr', '-CA', 'ca.pem', '-CAkey', 'signing.key', '-passin', 'stdin',
    '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-days', '397', '-sha256', '-extfile', 'server.ext', '-out', 'localhost.pem',
  ])
}

export function prepare_dev_certificate(directory: string, rotate = false, imported?: CertificateFiles) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stage = join(directory, '.cert-setup')
  try {
    mkdirSync(stage, { mode: 0o700 })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`Certificate setup is locked at ${stage}. If a previous setup was interrupted, inspect this directory before retrying`)
    throw error
  }
  try {
    const existing = files.filter(name => existsSync(join(directory, name)))
    if (existing.length && ! rotate) {
      try {
        return { fingerprint: certificate_fingerprint(directory), created: false }
      }
      catch { throw new Error('The current HTTPS files are incomplete, expired or incompatible. Use pnpm dev:cert --rotate to back them up and generate a new CA') }
    }
    if (imported) {
      for (const name of files)
        writeFileSync(join(stage, name), imported[name], { mode: 0o600 })
    }
    else {
      generate_certificates(stage)
    }
    const fingerprint = certificate_fingerprint(stage)
    const backup = existing.length ? mkdtempSync(join(directory, 'previous-')) : undefined
    const moved: string[] = []
    const installed: string[] = []
    try {
      if (backup) {
        for (const name of existing) {
          renameSync(join(directory, name), join(backup, name))
          moved.push(name)
        }
      }
      for (const name of files) {
        renameSync(join(stage, name), join(directory, name))
        installed.push(name)
      }
    }
    catch (error) {
      for (const name of installed)
        renameSync(join(directory, name), join(stage, name))
      for (const name of moved)
        renameSync(join(backup!, name), join(directory, name))
      throw error
    }
    return { created: true, fingerprint, backup }
  }
  finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

function user_certificate_directory() {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(base, 'stupig.tv', 'https')
}

/** Each checkout needs a Docker bind mount. The user's identity survives fresh checkouts. */
export function prepare_checkout_https(workspace: string, user_directory: string, action: 'start' | 'install' | 'rotate') {
  let imported: CertificateFiles | undefined
  if (action !== 'rotate' && ! files.some(name => existsSync(join(user_directory, name)))) {
    const present = files.filter(name => existsSync(join(workspace, name)))
    if (present.length && present.length < files.length) {
      const missing = files.filter(name => ! present.includes(name))
      throw new Error(`Reusing an existing development identity from ${workspace} needs all of ca.pem, localhost.pem and localhost.key together; missing ${missing.join(', ')}`)
    }
    if (present.length === files.length) {
      imported = {
        'ca.pem': readFileSync(join(workspace, 'ca.pem')),
        'localhost.pem': readFileSync(join(workspace, 'localhost.pem')),
        'localhost.key': readFileSync(join(workspace, 'localhost.key')),
      }
    }
    else if (action === 'start') {
      throw new Error('First setup: run pnpm dev:cert --install to create and trust a local development certificate, or place ca.pem, localhost.pem and localhost.key from another machine in .dev/https')
    }
  }
  const result = prepare_dev_certificate(user_directory, action === 'rotate', imported)
  const source: CertificateFiles = {
    'ca.pem': readFileSync(join(user_directory, 'ca.pem')),
    'localhost.pem': readFileSync(join(user_directory, 'localhost.pem')),
    'localhost.key': readFileSync(join(user_directory, 'localhost.key')),
  }
  const matches = files.every(name => existsSync(join(workspace, name)) && source[name].equals(readFileSync(join(workspace, name))))
  if (! matches)
    prepare_dev_certificate(workspace, true, source)
  return result
}

interface TrustOutcome {
  /** Whether the CA is now trusted for the browsers this platform normally uses. */
  automated: boolean
  /** What happened, or the commands the operator still needs to run. */
  details: string
}

function run_quiet(command: string, args: string[]) {
  const result = spawnSync(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  return { ok: ! result.error && result.status === 0, message: result.error?.message ?? result.stderr?.toString().trim() ?? '' }
}

/** Trust the development CA for the current user only; never touch the machine-wide stores. */
function trust_development_ca(ca_path: string): TrustOutcome {
  if (process.platform === 'win32') {
    const result = run_quiet('certutil.exe', ['-user', '-addstore', 'Root', ca_path])
    if (! result.ok)
      throw new Error(`Windows did not install the current user development CA (${result.message}). Run pnpm dev:cert --install to retry`)
    return { automated: true, details: 'current user trusted root store' }
  }
  if (process.platform === 'darwin') {
    const keychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db')
    const result = run_quiet('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, ca_path])
    if (! result.ok)
      throw new Error(`macOS did not trust the development CA (${result.message}). Approve the prompt, or run: security add-trusted-cert -r trustRoot -k "${keychain}" "${ca_path}"`)
    return { automated: true, details: 'login keychain' }
  }
  // Linux browsers keep their own stores; the system store needs root, so only
  // the Chromium NSS database is automated and the rest stays an instruction.
  const nss = join(homedir(), '.pki', 'nssdb')
  if (existsSync(nss)) {
    const result = run_quiet('certutil', ['-d', `sql:${nss}`, '-A', '-t', 'C,,', '-n', development_ca_name, '-i', ca_path])
    if (result.ok)
      return { automated: true, details: 'Chromium NSS database' }
  }
  return {
    automated: false,
    details: [
      `Trust ${ca_path} for the current user before opening the app.`,
      `Chromium: certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n ${development_ca_name} -i "${ca_path}"`,
      `System store (Debian/Ubuntu): sudo cp "${ca_path}" /usr/local/share/ca-certificates/${development_ca_name}.crt && sudo update-ca-certificates`,
      'Firefox keeps its own store; import the CA there if you use it.',
    ].join('\n'),
  }
}

/** EMQX mounts the CA at start, so a rotation only takes effect after recreation. */
function recreate_emqx(checkout: string) {
  const compose = ['compose', '--env-file', '.env.dev', '-f', 'docker-compose.dev.yml']
  const running = spawnSync('docker', [... compose, 'ps', '-q', 'emqx'], { cwd: checkout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  if (running.error || running.status !== 0 || ! running.stdout.toString().trim())
    return null
  const result = spawnSync('docker', [... compose, 'up', '-d', '--force-recreate', 'emqx'], { cwd: checkout, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  return ! result.error && result.status === 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length && ! (args.length === 1 && ['--install', '--rotate'].includes(args[0])))
      throw new Error('Usage: pnpm dev:cert [--install|--rotate]')
    const action = args[0] === '--install' ? 'install' : args[0] === '--rotate' ? 'rotate' : 'start'
    const workspace = dirname(dev_https_ca_path)
    const result = prepare_checkout_https(workspace, user_certificate_directory(), action)
    if (result.backup)
      console.log(`Previous certificates: ${result.backup}`)
    if (result.created || action === 'install') {
      console.log(`Development CA SHA-256: ${result.fingerprint}`)
      const trust = trust_development_ca(dev_https_ca_path)
      if (trust.automated)
        console.log(`Trusted the development CA (${trust.details}).`)
      else
        console.log(trust.details)
    }
    if (action === 'rotate') {
      const recreated = recreate_emqx(resolve(workspace, '../..'))
      if (recreated === true)
        console.log('Recreated the EMQX container so it mounts the new CA.')
      else if (recreated === false)
        console.error(`[dev:cert] EMQX is running but could not be recreated. Run: docker compose --env-file .env.dev -f docker-compose.dev.yml up -d --force-recreate emqx`)
    }
  }
  catch (error) {
    console.error(`[dev:cert] ${(error as Error).message}`)
    process.exitCode = 1
  }
}
