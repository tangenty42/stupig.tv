/**
 * Persists FileSystemFileHandles in IndexedDB so a pending upload can recover
 * its source file after a refresh without copying the blob. Handles are a few
 * hundred bytes and point back at the user's on-disk file, so this avoids the
 * GoldenRetriever blob store's 10MB/300MB caps entirely.
 */

export interface UploadFileHandleRecord {
  /** Actual on-disk file name (not the storage path). */
  file_name: string
  file_size: number
  handle: FileSystemFileHandle
}

const OBJECT_STORE = 'handles'

function open_db(db_name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(db_name, 1)
    request.onupgradeneeded = () => {
      if (! request.result.objectStoreNames.contains(OBJECT_STORE))
        request.result.createObjectStore(OBJECT_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function with_store<T>(
  db_name: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open_db(db_name)
  try {
    const store = db.transaction(OBJECT_STORE, mode).objectStore(OBJECT_STORE)
    return await new Promise<T>((resolve, reject) => {
      const request = run(store)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
  finally {
    db.close()
  }
}

export function save_upload_file_handle(db_name: string, key: string, record: UploadFileHandleRecord) {
  return with_store(db_name, 'readwrite', store => store.put(record, key))
}

export function load_upload_file_handle(db_name: string, key: string): Promise<UploadFileHandleRecord | null> {
  return with_store(db_name, 'readonly', store => store.get(key))
}

export function delete_upload_file_handle(db_name: string, key: string) {
  return with_store(db_name, 'readwrite', store => store.delete(key))
}
