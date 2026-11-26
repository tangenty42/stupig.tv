import { fileURLToPath } from 'node:url'

export const dev_https_ca_path = fileURLToPath(new URL('../../.dev/https/ca.pem', import.meta.url))
export const dev_https_cert_path = fileURLToPath(new URL('../../.dev/https/localhost.pem', import.meta.url))
export const dev_https_key_path = fileURLToPath(new URL('../../.dev/https/localhost.key', import.meta.url))
