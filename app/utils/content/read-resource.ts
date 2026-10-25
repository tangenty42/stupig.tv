import { get_error_status } from '~/composables/useApi'

/** A confirmed absence is query data, so shared subscribers also lose stale copies. */
export async function read_content_resource<T>(fetcher: () => Promise<T>) {
  try {
    return await fetcher()
  }
  catch (error) {
    if (get_error_status(error) === 404)
      return null
    throw error
  }
}
