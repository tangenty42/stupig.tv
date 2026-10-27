/** Type bridge for the single-file ESA deployment and standalone Node tooling. */

/**
 * Function variables published by `pnpm esa:deploy:*` (see `scripts/esa/config.ts`).
 * A variable missing from the deployed function reads as `undefined`, which both
 * entry points treat as fail-closed (503), never as an empty usable value.
 */
export interface EsaFunctionVariables {
  readonly ALIYUN_ESA_AUTH_KEY?: string
  readonly CONTENT_AUTH_URL?: string
  readonly CONTENT_AUTH_TIMEOUT_MS?: string
}

export function create_content_bypass<Result = unknown>(privateKey: string | undefined, ttlSeconds?: number, respond?: (allowed: boolean, status: number) => Result, authorize?: (request: Request) => Promise<number>): (request: Request) => Promise<Result>
export function authorize_content_request(privateKey: string, ttlSeconds: number, request: Request): { status: number, url: URL | null, disposition: string | null }
export function content_url_signature(privateKey: string, url: URL, issuedAt: string, expiresAt: string, nonce: string): string
export function content_authorization_proof(privateKey: string, nonce: string, url: string, method: string): string
export function create_content_authorizer(privateKey: string | undefined, endpoint: string | undefined, timeoutMs?: number, authorizationFetch?: typeof fetch): (request: Request) => Promise<number>

declare const handler: {
  bypass: (request: Request) => Promise<unknown>
}
export default handler
