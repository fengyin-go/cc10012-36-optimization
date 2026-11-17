/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 调度运行记录：每个业务窗口的每一次尝试一行，窗口来源与批次全程留痕。 */
export type ScheduleRunRow = EntryRow & {
  记录编号: string
  配置编号: string
  关联任务: string
  业务窗口: string
  窗口来源: string
  重试序号: number
  已重试次数: number
  重试上限: number
  运行结果: string
  窗口状态: string
  前置任务读取: string
  批次号: string
  冲突处理: string
  归档标记: string
  配置快照: string
  运行时间: string
}

/** 调度域动作返回：除成功标志外，携带批次号、补偿窗口与跳过窗口，便于页面复核。 */
export type ScheduleActionResult = ActionResult & {
  batchNo?: string
  processedWindows?: string[]
  skippedWindows?: string[]
  appendedCount?: number
}
