/** Standard JSON envelope for all API responses */
export interface ApiResponse<T = unknown> {
  success: boolean
  data: T | null
  message: string
}

export function ok<T>(data: T, message = 'OK'): ApiResponse<T> {
  return { success: true, data, message }
}

export function fail(message = '不知道什么鬼出错了'): ApiResponse<null> {
  return { success: false, data: null, message }
}
