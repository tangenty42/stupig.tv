import { afterEach, expect, it, vi } from 'vitest'
import { attachment_picks_from_data_transfer } from './upload-picks'

afterEach(() => vi.unstubAllGlobals())

it('uses resumable handles when a drop exposes the File System Access API', async () => {
  vi.stubGlobal('DataTransferItem', class {
    getAsFileSystemHandle() {}
  })
  const file = new File(['bytes'], 'photo.png')
  const handle = { kind: 'file', name: file.name, getFile: async () => file } as FileSystemFileHandle
  const transfer = { items: [{ getAsFileSystemHandle: async () => handle }], files: [] } as unknown as DataTransfer
  expect(await attachment_picks_from_data_transfer(transfer)).toEqual([{ file, file_name: file.name, handle }])
})

it('falls back to recursive webkit entries and then flat files', async () => {
  vi.stubGlobal('DataTransferItem', class {})
  const nested = new File(['nested'], 'nested.txt')
  const file_entry = { name: nested.name, isFile: true, isDirectory: false, file: (resolve: (file: File) => void) => resolve(nested) }
  let reads = 0
  const directory = {
    name: 'folder', isFile: false, isDirectory: true,
    createReader: () => ({ readEntries: (resolve: (entries: FileSystemEntry[]) => void) => resolve(reads ++ ? [] : [file_entry as unknown as FileSystemEntry]) }),
  }
  const entries = { items: [{ webkitGetAsEntry: () => directory }], files: [] } as unknown as DataTransfer
  expect(await attachment_picks_from_data_transfer(entries)).toEqual([{ file: nested, file_name: 'folder/nested.txt', selection_root: 'folder' }])

  const flat = new File(['flat'], 'flat.txt')
  const files = { items: [], files: [flat] } as unknown as DataTransfer
  expect(await attachment_picks_from_data_transfer(files)).toEqual([{ file: flat, file_name: flat.name }])
})
