import type { PublicApiError } from '@shared/api-error'
import { parse_public_api_error } from '@shared/api-error'

export class ApiError extends Error {
  public readonly statusCode: number
  public readonly public_data?: PublicApiError

  public constructor(statusCode: number, message: string, public_data?: PublicApiError) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.public_data = parse_public_api_error(public_data)
  }
}
