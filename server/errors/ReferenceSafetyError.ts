import type { ReferenceSafetyCode } from '@shared/content-reference-error'
import { ApiError } from './ApiError'

export class ReferenceSafetyError extends ApiError {
  constructor(message: string, public readonly reference_code: ReferenceSafetyCode) {
    super(409, message)
  }
}
