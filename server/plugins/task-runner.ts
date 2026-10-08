import { start_task_runner } from '@server/services/content/task-runner.service'

// 附件任务队列的进程内 runner（docs/content-task-refactor.md §5）。任务创建时
// 由 createTask 即时 kick；这里的 interval 是兜底：清扫中断任务的租约、重试
// 仍在排队的任务。
export default defineNitroPlugin(() => {
  start_task_runner()
})
