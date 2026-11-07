/**
 * Augment lib.dom.d.ts with the Chromium-only File System Access APIs used for
 * zero-copy upload resume. TypeScript's DOM lib only ships APIs supported by
 * two or more browser engines, so a newer TypeScript will not add these.
 * Interface merging keeps the existing `FileSystemHandle` hierarchy intact;
 * `FileSystemDirectoryHandle.values()` comes from the `dom.asynciterable` lib.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

interface FileSystemFileHandle {
  requestPermission: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>
  queryPermission: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>
}

interface DataTransferItem {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>
}

interface FilePickerAcceptType {
  description?: string
  accept: Record<string, string[]>
}

interface OpenFilePickerOptions {
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  types?: FilePickerAcceptType[]
}

interface DirectoryPickerOptions {
  id?: string
  mode?: 'read' | 'readwrite'
}

interface Window {
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>
}
