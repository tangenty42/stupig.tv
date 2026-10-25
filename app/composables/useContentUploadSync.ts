import { sync_resource } from '@shared/types/sync'
import { useContentUploadsStore } from '~/stores/contentUploads'
import { upload_session_unavailable } from '~/utils/content/upload-runtime'

export async function useContentUploadSync(scope: number) {
  const { content } = useApi()
  const store = useContentUploadsStore(scope)
  const toast = useMyToast()
  const resource = sync_resource('content_uploads', scope)
  interface Snapshot { epoch: number, value: Awaited<ReturnType<typeof content.list_upload_sessions>> }
  // Use the same resource projection for subscription writes and command receipts.
  const data = useSyncedState(computed<Snapshot | null>({
    get: () => store.ready ? { epoch: store.snapshot_epoch(), value: { enabled: store.enabled, sessions: store.sessions, reservations: store.reservations } } : null,
    set: (result) => {
      if (result)
        store.apply_list(result.value, result.epoch)
    },
  }))
  await useSyncedData(resource, async () => {
    const epoch = store.snapshot_epoch()
    try {
      return { epoch, value: await content.list_upload_sessions(scope) }
    }
    catch (error) {
      if (epoch !== store.snapshot_epoch())
        return null
      throw error
    }
  }, data, {
    server: false,
    query_key: computed(() => `${resource}:${store.identity_key}`),
    on_error: (error) => {
      if (upload_session_unavailable(error))
        store.reset()
      toast.error(error)
    },
  })
}
