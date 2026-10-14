import type { PendingTaskRow } from '~/utils/content/task-row'
import { describe, expect, it } from 'vitest'
import { pending_upload_card, pending_upload_percent, pending_upload_source_name, pending_upload_status, task_item_display_name, task_resolution_choices } from '~/utils/content/task-row'

describe('task report names', () => {
  it('跳过报告保留原始文件名，不暴露占位路径', () => {
    expect(task_item_display_name({ path: '__pending_upload_0', result: { resolution: { from: 'probe.txt' } } })).toBe('probe.txt')
    expect(task_item_display_name({ path: '__pending_upload_0', result: { resolve: { from: 'raw name.txt' } } })).toBe('raw name.txt')
    expect(task_item_display_name({ path: 'empty.txt', result: { reason: '文件为空' } })).toBe('empty.txt')
  })
})

describe('resolve choices', () => {
  const resolution = { kind: 'rename' as const, from: 'a.png', to: 'a-1.png', reason: '冲突' }
  const items = [
    { name: 'a.png', item_id: 11, resolution },
    { name: 'b.png', item_id: 12, resolution },
    { name: 'bad.png', item_id: 13, reason: '非法名称' },
    { name: 'report.png', reason: '只读报告' },
  ]

  it('待处理项默认全部跳过，只读报告不提交', () => {
    expect(task_resolution_choices(items)).toEqual([{ item_id: 11, choice: 'skip' }, { item_id: 12, choice: 'skip' }])
    expect(task_resolution_choices([{ name: 'report.png', reason: '只读报告' }])).toEqual([])
  })

  it('按显式选择汇总，其余继续跳过，忽略已经移除项的旧选择', () => {
    expect(task_resolution_choices(items, new Map([[11, 'apply'], [99, 'apply']]))).toEqual([
      { item_id: 11, choice: 'apply' }, { item_id: 12, choice: 'skip' },
    ])
  })
})

function make_row(overrides: Partial<PendingTaskRow> = {}): PendingTaskRow {
  return {
    task_id: 7,
    item_id: 1,
    path: 'a.png',
    source_file_name: null,
    kind: 'upload',
    task_status: 'running',
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
    resolution: null,
    ... overrides,
  }
}

it('续传选择匹配原始源文件名，历史任务回退到路径末段', () => {
  expect(pending_upload_source_name(make_row({ path: 'folder/ab-1.png', source_file_name: 'a b.PNG' }))).toBe('a b.PNG')
  expect(pending_upload_source_name(make_row({ path: 'folder/a.png' }))).toBe('a.png')
})

describe('pending upload row status', () => {
  it('明确暂停后保留进度，但不能因已有字节或旧驱动标记显示为上传中', () => {
    const row = make_row({ bytes_done: 43, is_paused: true, is_driving: true })
    expect(pending_upload_status(row)).toBe('paused')
    expect(pending_upload_card(row)).toMatchObject({ status: 'paused', progress: 43, indeterminate: false })
  })
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

  it('只有失败项读作错误，跳过属于已结束而非可重试错误', () => {
    expect(pending_upload_status(make_row({ status: 'failed' }))).toBe('error')
    expect(pending_upload_status(make_row({ status: 'skipped' }))).toBe('completed')
  })

  it('落地的任务项读作完成', () => {
    expect(pending_upload_status(make_row({ status: 'done' }))).toBe('completed')
  })

  it('服务端执行的任务项（加解密）从排队起就是进行中，没有客户端暂停态', () => {
    const encrypt = { kind: 'encrypt', action: 'encrypt', is_transfer: false } as const
    expect(pending_upload_status(make_row({ ... encrypt, status: 'pending' }))).toBe('uploading')
    expect(pending_upload_status(make_row({ ... encrypt, status: 'active' }))).toBe('uploading')
  })

  it('一个 resolve 项暂停整个任务时，其他 active upload 行也不可继续上传', () => {
    const row = make_row({ task_status: 'paused', status: 'active' })
    expect(pending_upload_status(row)).toBe('queued')
    expect(pending_upload_card(row)).toMatchObject({ pending_label: '等待名称处理' })
  })

  it('resolve 项携带建议名称且不产生虚假字节进度', () => {
    const card = pending_upload_card(make_row({
      task_status: 'paused',
      status: 'pending',
      bytes_total: 0,
      resolution: { kind: 'sanitize', from: 'a b.png', to: 'ab.png', reason: 'sanitize' },
    }))

    expect(card).toMatchObject({ status: 'queued', pending_label: '待处理', resolution: { to: 'ab.png' } })
    if (card.kind === 'upload')
      expect(card.indeterminate).toBe(false)
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
      resolution: null,
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
