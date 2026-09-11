/**
 * Augment lib.dom.d.ts with the File System Access APIs that TypeScript 5.9
 * does not type yet. Interface merging keeps the existing `FileSystemHandle`
 * hierarchy intact while adding the Chromium-only methods this project uses
 * for zero-copy upload resume.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

interface FileSystemFileHandle {
  requestPermission: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>
  queryPermission: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>
}

interface FileSystemDirectoryHandle {
  values: () => AsyncIterableIterator<FileSystemHandle>
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
