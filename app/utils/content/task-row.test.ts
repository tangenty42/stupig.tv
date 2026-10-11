import type { PendingTaskRow } from '~/utils/content/task-row'
import { describe, expect, it } from 'vitest'
import { pending_upload_card, pending_upload_percent, pending_upload_status } from '~/utils/content/task-row'

function make_row(overrides: Partial<PendingTaskRow> = {}): PendingTaskRow {
  return {
    task_id: 7,
    item_id: 1,
    path: 'a.png',
    kind: 'upload',
    action: 'upload',
    is_transfer: true,
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

  it('服务端执行的任务项（加解密）从排队起就是进行中，没有客户端暂停态', () => {
    const encrypt = { kind: 'encrypt', action: 'encrypt', is_transfer: false } as const
    expect(pending_upload_status(make_row({ ... encrypt, status: 'pending' }))).toBe('uploading')
    expect(pending_upload_status(make_row({ ... encrypt, status: 'active' }))).toBe('uploading')
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
      indeterminate: false,
      pending_label: null,
      server_side: false,
    })
  })

  it('错误信息与不可续传都透传到卡片', () => {
    const card = pending_upload_card(make_row({ status: 'failed', error: '任务中断，请重试', can_resume: false }))

    expect(card).toMatchObject({ status: 'error', message: '任务中断，请重试', can_resume: false })
  })

  it('服务端执行的加密项：不定进度 + 文案，无字节进度', () => {
    const card = pending_upload_card(make_row({
      kind: 'encrypt',
      action: 'encrypt',
      is_transfer: false,
      status: 'pending',
      bytes_total: 0,
    }))

    expect(card).toMatchObject({
      status: 'uploading',
      progress: 0,
      indeterminate: true,
      pending_label: '加密中',
      server_side: true,
    })
  })

  it('解密项的文案是解密中', () => {
    const card = pending_upload_card(make_row({
      kind: 'decrypt',
      action: 'decrypt',
      is_transfer: false,
      status: 'pending',
    }))

    expect(card).toMatchObject({ indeterminate: true, pending_label: '解密中' })
  })

  it('服务端项终态后不再是不定进度（失败行按错误显示）', () => {
    const card = pending_upload_card(make_row({
      kind: 'encrypt',
      action: 'encrypt',
      is_transfer: false,
      status: 'failed',
      error: '任务已取消',
    }))

    expect(card).toMatchObject({ status: 'error', indeterminate: false, pending_label: null, message: '任务已取消' })
  })
})
