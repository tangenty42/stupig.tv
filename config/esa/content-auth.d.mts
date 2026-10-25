/** Type bridge for the single-file ESA deployment and standalone Node tooling. */
export function create_content_auth(privateKey: string, ttlSeconds?: number, originFetch?: typeof fetch, authorize?: (request: Request) => Promise<number>): (request: Request) => Promise<Response>
export function create_content_bypass<Result = unknown>(privateKey: string, ttlSeconds?: number, respond?: (allowed: boolean, status: number) => Result, authorize?: (request: Request) => Promise<number>): (request: Request) => Promise<Result>
export function authorize_content_request(privateKey: string, ttlSeconds: number, request: Request): { status: number, url: URL | null, disposition: string | null }
export function content_signature_metadata(disposition: string, access?: string): string
export function content_authorization_proof(privateKey: string, nonce: string, url: string, method: string): string
export function create_content_authorizer(privateKey: string, endpoint: string, timeoutMs?: number, authorizationFetch?: typeof fetch): (request: Request) => Promise<number>

declare const handler: {
  bypass: (request: Request) => Promise<unknown>
}
export default handler
