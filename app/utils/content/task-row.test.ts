import type { PendingUploadRow } from '~/utils/content/task-row'
import { describe, expect, it } from 'vitest'
import { pending_upload_card, pending_upload_percent, pending_upload_status } from '~/utils/content/task-row'

function make_row(overrides: Partial<PendingUploadRow> = {}): PendingUploadRow {
  return {
    task_id: 7,
    item_id: 1,
    path: 'a.png',
    status: 'active',
    bytes_done: 0,
    bytes_total: 100,
    mime_type: 'image/png',
    is_driving: false,
    speed: 0,
    can_resume: true,
    error: null,
    ... overrides,
  }
}

describe('pending upload row status', () => {
  it('进行中的任务项：本机在传或已有字节进展都算上传中', () => {
    expect(pending_upload_status(make_row({ is_driving: true }))).toBe('uploading')
    expect(pending_upload_status(make_row({ bytes_done: 40 }))).toBe('uploading')
  })

  it('没有任何进展的 active 项读作已暂停（等待人手继续）', () => {
    expect(pending_upload_status(make_row())).toBe('paused')
  })

  it('排队中的任务项读作等待上传', () => {
    expect(pending_upload_status(make_row({ status: 'pending' }))).toBe('queued')
  })

  it('失败与被跳过的任务项都读作错误', () => {
    expect(pending_upload_status(make_row({ status: 'failed' }))).toBe('error')
    expect(pending_upload_status(make_row({ status: 'skipped' }))).toBe('error')
  })

  it('落地的任务项读作完成', () => {
    expect(pending_upload_status(make_row({ status: 'done' }))).toBe('completed')
  })
})

describe('pending upload row percentage', () => {
  it('按字节计算并封顶 100', () => {
    expect(pending_upload_percent(make_row({ bytes_done: 25, bytes_total: 100 }))).toBe(25)
    expect(pending_upload_percent(make_row({ bytes_done: 100, bytes_total: 100 }))).toBe(100)
    expect(pending_upload_percent(make_row({ bytes_done: 999, bytes_total: 100 }))).toBe(100)
  })

  it('未知总量时为 0，而不是 Infinity', () => {
    expect(pending_upload_percent(make_row({ bytes_total: 0 }))).toBe(0)
    expect(pending_upload_percent(make_row({ bytes_total: 0, status: 'done' }))).toBe(100)
  })
})

describe('pending upload card', () => {
  it('把行投影成卡片数据（文件名、体积、速率与错误都带上）', () => {
    const card = pending_upload_card(make_row({
      path: 'folder/b.png',
      mime_type: 'image/webp',
      bytes_done: 50,
      bytes_total: 200,
      is_driving: true,
      speed: 1024,
      error: null,
    }))

    expect(card).toEqual({
      kind: 'upload',
      file_name: 'folder/b.png',
      mime_type: 'image/webp',
      file_size: 200,
      status: 'uploading',
      progress: 25,
      speed: 1024,
      message: null,
      can_resume: true,
    })
  })

  it('错误信息与不可续传都透传到卡片', () => {
    const card = pending_upload_card(make_row({ status: 'failed', error: '任务中断，请重试', can_resume: false }))

    expect(card).toMatchObject({ status: 'error', message: '任务中断，请重试', can_resume: false })
  })
})
