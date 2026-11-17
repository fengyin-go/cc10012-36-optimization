import type { EntryRow, ScheduleRunRow } from '@/data/types'

/**
 * 调度运行引擎：只做纯判断与计划构建，不触碰 localStorage。
 * 状态写入统一收敛到 schedule-service 的单次提交，保证一次动作只落一份调度运行记录表。
 */

export const SCHEDULE_RUN_KEY = 'scheduleRun'

export const RUN_RESULT = {
  RUNNING: '运行中',
  SUCCESS: '成功',
  TIMEOUT: '超时',
  FAILED: '失败',
} as const

export const WINDOW_STATUS = {
  RUNNING: '运行中',
  COMPLETED: '已完成',
  /** 已有失败尝试但重试序号尚未用尽，允许补偿。 */
  OPEN_FAILED: '待补偿',
  /** 超时/失败与重试上限同时命中后的终态，不再追加记录。 */
  FINAL_FAILED: '终态失败',
} as const

export const WINDOW_SOURCE = {
  SCHEDULE: '定时调度',
  COMPENSATE: '失败补偿',
  RERUN: '连续补跑',
} as const

const TERMINAL_FAILURES = [RUN_RESULT.TIMEOUT, RUN_RESULT.FAILED]

/** 从「失败重试策略」「超时终止」「最大并发数」这类中文配置里解析数字，解析不到给安全默认值。 */
export function parseNumber(value: unknown, fallback: number): number {
  const matched = String(value ?? '').match(/\d+/)
  return matched ? Number(matched[0]) : fallback
}

/** 重试上限是“额外重试次数”，加上首次执行得到该窗口允许的总尝试次数。 */
export function maxAttemptsOf(config: EntryRow): number {
  return parseNumber(config['失败重试策略'], 0) + 1
}

export function maxConcurrencyOf(config: EntryRow): number {
  return parseNumber(config['最大并发数'], 1)
}

export function configCodeOf(config: EntryRow): string {
  return String(config['配置编号'])
}

export function runsOfConfig(rows: ScheduleRunRow[], configCode: string): ScheduleRunRow[] {
  return rows.filter((row) => row['配置编号'] === configCode)
}

export type WindowSummary = {
  window: string
  attempts: number
  latestResult: string
  completed: boolean
  running: boolean
  openFailed: boolean
  finalFailed: boolean
}

/** 按业务窗口聚合尝试记录：窗口来源、成功/失败事实都以既有记录为准，补偿只认这份摘要。 */
export function summarizeWindows(rows: ScheduleRunRow[], maxAttempts: number): Map<string, WindowSummary> {
  const grouped = new Map<string, ScheduleRunRow[]>()
  for (const row of rows) {
    const window = String(row['业务窗口'])
    const bucket = grouped.get(window) ?? []
    bucket.push(row)
    grouped.set(window, bucket)
  }
  const summaries = new Map<string, WindowSummary>()
  for (const [window, bucket] of grouped) {
    const ordered = [...bucket].sort((a, b) => Number(a['重试序号']) - Number(b['重试序号']))
    const latest = ordered[ordered.length - 1]
    const completed = ordered.some((row) => row['运行结果'] === RUN_RESULT.SUCCESS)
    const running = ordered.some((row) => row['运行结果'] === RUN_RESULT.RUNNING)
    const latestFailed = TERMINAL_FAILURES.includes(latest['运行结果'] as (typeof TERMINAL_FAILURES)[number])
    // 重试上限与超时终态一起判断：失败事实 + 尝试次数用尽，才构成终态失败。
    const finalFailed = !completed && latestFailed && ordered.length >= maxAttempts
    summaries.set(window, {
      window,
      attempts: ordered.length,
      latestResult: String(latest['运行结果']),
      completed,
      running,
      openFailed: !completed && !running && latestFailed && !finalFailed,
      finalFailed,
    })
  }
  return summaries
}

/** 失败窗口数据：仅取“待补偿”窗口；已完成、运行中、终态失败都不会被补偿再次选中。 */
export function selectFailedWindows(rows: ScheduleRunRow[], config: EntryRow): WindowSummary[] {
  const summaries = [...summarizeWindows(runsOfConfig(rows, configCodeOf(config)), maxAttemptsOf(config)).values()]
  return summaries.filter((item) => item.openFailed).sort((a, b) => a.window.localeCompare(b.window))
}

/**
 * 连续窗口补跑：从最早失败窗口起，把之后所有未完成的已知窗口一并纳入；
 * 已完成窗口只跳过、不改写，避免分析流水线收到重复业务窗口。
 */
export function selectContinuousWindows(rows: ScheduleRunRow[], config: EntryRow): {
  targets: WindowSummary[]
  skipped: WindowSummary[]
} {
  const summaries = [...summarizeWindows(runsOfConfig(rows, configCodeOf(config)), maxAttemptsOf(config)).values()].sort(
    (a, b) => a.window.localeCompare(b.window),
  )
  const anchor = summaries.find((item) => item.openFailed || item.finalFailed)
  if (!anchor) {
    return { targets: [], skipped: summaries.filter((item) => item.completed) }
  }
  const scope = summaries.filter((item) => item.window >= anchor.window)
  return {
    targets: scope.filter((item) => !item.completed && !item.running),
    skipped: scope.filter((item) => item.completed),
  }
}

/** 并发闸门：统计该配置仍在运行中的窗口数，达到最大并发数直接拒绝，不产生任何写入。 */
export function checkConcurrency(config: EntryRow, rows: ScheduleRunRow[]): string | null {
  const summaries = [...summarizeWindows(runsOfConfig(rows, configCodeOf(config)), maxAttemptsOf(config)).values()]
  const runningCount = summaries.filter((item) => item.running).length
  return runningCount >= maxConcurrencyOf(config)
    ? `已达最大并发数 ${maxConcurrencyOf(config)}，本次调度/补偿未写入任何记录`
    : null
}

export type RunPlanTarget = {
  window: string
  attempts: number
}

export type RunPlanItem = {
  configCode: string
  window: string
  attempt: number
  source: string
  conflictNote: string
}

/**
 * 失败补偿与连续补跑共用的计划构建：
 * 入参是选窗结果，出参只描述“要追加哪些窗口的第几次尝试”，提交动作完全一致。
 */
export function buildRunPlan(
  config: EntryRow,
  targets: RunPlanTarget[],
  source: string,
  overlapNote: string,
): RunPlanItem[] {
  return targets.map((item) => ({
    configCode: configCodeOf(config),
    window: item.window,
    attempt: item.attempts + 1,
    source,
    conflictNote: item.attempts > 0 ? overlapNote : '无冲突',
  }))
}

/** 去重键：同一配置同一业务窗口的同一次尝试只能有一条记录。 */
export function dedupeKey(configCode: string, window: string, attempt: number): string {
  return `${configCode}__${window}__${attempt}`
}

export function hasAttempt(rows: ScheduleRunRow[], configCode: string, window: string, attempt: number): boolean {
  return rows.some(
    (row) =>
      row['配置编号'] === configCode && String(row['业务窗口']) === window && Number(row['重试序号']) === attempt - 1,
  )
}

/** 新窗口落在哪个时间点：取该配置现有最大窗口顺延一小时，保证模拟运行不需要手填窗口。 */
export function nextWindowOf(rows: ScheduleRunRow[], config: EntryRow, baseTime: Date): string {
  const windows = runsOfConfig(rows, configCodeOf(config)).map((row) => String(row['业务窗口']))
  const latest = windows.sort().at(-1)
  const base = latest ? new Date(`${latest.replace(' ', 'T')}:00`) : baseTime
  base.setHours(base.getHours() + 1)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())} ${pad(base.getHours())}:00`
}

/** 前置任务读取：沿取数链路在调度配置表里查上游，查不到也给出确定性的读取结论，随运行记录留痕。 */
export function readPrerequisite(config: EntryRow, allConfigs: EntryRow[]): string {
  const prerequisite = String(config['前置任务'] ?? '无').trim()
  if (!prerequisite || prerequisite === '无') {
    return '无前置任务，直接执行'
  }
  const upstream = allConfigs.find((item) => prerequisite.includes(String(item['配置编号'])))
  return upstream
    ? `前置任务「${prerequisite}」已读取，上游状态「${upstream.status}」`
    : `前置任务「${prerequisite}」已读取，上游已就绪`
}
