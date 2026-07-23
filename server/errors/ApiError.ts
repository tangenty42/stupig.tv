export class ApiError extends Error {
  public readonly statusCode: number

  public constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
  }
}
