import type OpenApiClass from '@alicloud/openapi-client'
import type { PublishConfig } from './config'
import OpenApiModule, { Config, OpenApiRequest, Params } from '@alicloud/openapi-client'
import { RuntimeOptions } from '@alicloud/tea-util'
import { PublishError } from './config'

function wrapped_default(value: unknown): value is { default: typeof OpenApiClass } {
  return typeof value === 'object' && value !== null && 'default' in value
}
const OpenApi = wrapped_default(OpenApiModule) ? OpenApiModule.default : OpenApiModule as unknown as typeof OpenApiClass

export type Action = 'GetRoutine' | 'ListRoutineRoutes' | 'ListRoutineEnvironmentVariables' | 'SetRoutineEnvironmentVariables'
  | 'GetRoutineCodeVersion' | 'GetRoutineCodeVersionInfo' | 'ListRoutineCodeVersions' | 'CreateRoutineCodeDeployment'
export type Api = (action: Action, fields: Record<string, string>) => Promise<Record<string, unknown>>

export function create_api(config: PublishConfig): Api {
  const client = new OpenApi(new Config({
    accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret,
    endpoint: config.endpoint, regionId: config.regionId,
  }))
  return async (action, fields) => {
    try {
      const response = await client.callApi(new Params({
        action, version: '2024-09-10', protocol: 'HTTPS', pathname: '/', method: 'POST',
        authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json',
      }), new OpenApiRequest(action === 'ListRoutineRoutes' ? { query: fields } : { body: fields }), new RuntimeOptions({
        autoretry: false, readTimeout: config.timeoutMs, connectTimeout: config.timeoutMs,
      }))
      if (response.statusCode !== 200 || ! response.body || typeof response.body !== 'object')
        throw new Error('Invalid response')
      return response.body as Record<string, unknown>
    }
    catch {
      // SDK errors include signed headers and request bodies (including secrets).
      // Mutations may have succeeded even if the acknowledgement was lost.
      throw new PublishError(`${action} failed; check ESA permissions/network and console state before retrying`)
    }
  }
}
