import { listRows, saveRows } from '@/data/local-store'
import { filterRows } from '../local-service'
import {
  RUN_RESULT,
  SCHEDULE_RUN_KEY,
  WINDOW_SOURCE,
  WINDOW_STATUS,
  buildRunPlan,
  checkConcurrency,
  configCodeOf,
  dedupeKey,
  hasAttempt,
  maxAttemptsOf,
  nextWindowOf,
  readPrerequisite,
  runsOfConfig,
  selectContinuousWindows,
  selectFailedWindows,
  summarizeWindows,
  type RunPlanItem,
} from './schedule-engine'
import type {
  ActionResult,
  EntryRow,
  PageResult,
  ScheduleActionResult,
  ScheduleRunRow,
} from '@/data/types'

/**
 * 调度运行记录取数链路：页面 → schedule-service → local-store(localStorage)。
 * 本文件是「调度运行记录表」唯一的更新点：任何动作都只在末尾调用一次 commitRows，
 * 一次提交只写入一份表，避免重复批次。
 */

const RUN_FIELDS = [
  '记录编号',
  '配置编号',
  '关联任务',
  '业务窗口',
  '窗口来源',
  '重试序号',
  '已重试次数',
  '重试上限',
  '运行结果',
  '窗口状态',
  '前置任务读取',
  '批次号',
  '冲突处理',
  '归档标记',
  '归档时间',
  '配置快照',
  '运行时间',
]

export const RUN_FIELD_LIST = RUN_FIELDS

function loadRuns(): ScheduleRunRow[] {
  return listRows(SCHEDULE_RUN_KEY) as ScheduleRunRow[]
}

/** 唯一写入入口：并发补偿也走这里，调用方先在内存里算好全量行，再一次性落盘。 */
function commitRows(rows: ScheduleRunRow[]): void {
  saveRows(SCHEDULE_RUN_KEY, rows)
}

function loadConfigs(): EntryRow[] {
  return listRows('schedule')
}

function findConfig(id: number): EntryRow | undefined {
  return loadConfigs().find((row) => Number(row.id) === id)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`
}

function makeBatchNo(date: Date): string {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}${pad(date.getSeconds())}`
  return `BATCH-${stamp}-${Math.floor(Math.random() * 900 + 100)}`
}

function nextRowId(rows: ScheduleRunRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextRunNo(rows: ScheduleRunRow[]): string {
  const maxNo = rows.reduce((max, row) => {
    const matched = String(row['记录编号']).match(/(\d+)$/)
    return Math.max(max, matched ? Number(matched[1]) : 0)
  }, 0)
  return `RUN-${String(maxNo + 1).padStart(4, '0')}`
}

function snapshotConfig(config: EntryRow): string {
  const snapshot: Record<string, unknown> = {}
  for (const field of ['配置编号', '关联任务', '调度表达式', '时区设定', '前置任务', '最大并发数', '失败重试策略', '超时终止']) {
    snapshot[field] = config[field]
  }
  return JSON.stringify(snapshot)
}

function buildRunRow(args: {
  rows: ScheduleRunRow[]
  config: EntryRow
  window: string
  attempt: number
  result: string
  windowStatus: string
  source: string
  batchNo: string
  conflictNote: string
  prerequisite: string
  now: Date
}): ScheduleRunRow {
  const attemptIndex = args.attempt - 1
  return {
    id: nextRowId(args.rows),
    status: args.windowStatus,
    pending: args.windowStatus === WINDOW_STATUS.OPEN_FAILED || args.windowStatus === WINDOW_STATUS.RUNNING,
    abnormal: args.windowStatus === WINDOW_STATUS.FINAL_FAILED,
    记录编号: nextRunNo(args.rows),
    配置编号: configCodeOf(args.config),
    关联任务: String(args.config['关联任务']),
    业务窗口: args.window,
    窗口来源: args.source,
    重试序号: attemptIndex,
    已重试次数: attemptIndex,
    重试上限: maxAttemptsOf(args.config) - 1,
    运行结果: args.result,
    窗口状态: args.windowStatus,
    前置任务读取: args.prerequisite,
    批次号: args.batchNo,
    冲突处理: args.conflictNote,
    归档标记: '未归档',
    归档时间: '',
    配置快照: snapshotConfig(args.config),
    运行时间: formatTime(args.now),
  }
}

type AppliedPlan = {
  rows: ScheduleRunRow[]
  appended: ScheduleRunRow[]
  skippedKeys: string[]
}

/**
 * 共用步骤：调度模拟、失败补偿、连续补跑都收敛到这里。
 * 只追加未完成窗口的新尝试；去重键命中（同配置同窗口同次尝试）直接跳过且不改写既有记录。
 */
function appendPlan(
  rows: ScheduleRunRow[],
  config: EntryRow,
  plan: RunPlanItem[],
  result: string,
  now: Date,
  batchNo: string,
): AppliedPlan {
  const next = [...rows]
  const appended: ScheduleRunRow[] = []
  const skippedKeys: string[] = []
  const maxAttempts = maxAttemptsOf(config)
  const prerequisite = readPrerequisite(config, loadConfigs())
  for (const item of plan) {
    // 去重闸门：并发补偿命中已写入的同次尝试时只跳过，已完成记录绝不可能被改写。
    if (hasAttempt(next, item.configCode, item.window, item.attempt)) {
      skippedKeys.push(dedupeKey(item.configCode, item.window, item.attempt))
      continue
    }
    const willExhaust = item.attempt >= maxAttempts
    const windowStatus =
      result === RUN_RESULT.SUCCESS
        ? WINDOW_STATUS.COMPLETED
        : willExhaust
          ? WINDOW_STATUS.FINAL_FAILED
          : WINDOW_STATUS.OPEN_FAILED
    const row = buildRunRow({
      rows: next,
      config,
      window: item.window,
      attempt: item.attempt,
      result,
      windowStatus,
      source: item.source,
      batchNo,
      conflictNote: item.conflictNote,
      prerequisite,
      now,
    })
    next.push(row)
    appended.push(row)
  }
  return { rows: next, appended, skippedKeys }
}

function ensureRunnable(config: EntryRow | undefined, id: number): ActionResult | null {
  if (!config) {
    return { ok: false, message: `没有找到编号为 ${id} 的调度配置` }
  }
  if (config.status !== '已启用') {
    return { ok: false, message: `调度配置「${configCodeOf(config)}」当前为「${config.status}」，启用后才能产生调度运行记录` }
  }
  return null
}

/** 模拟定时调度：读取前置任务后为下一个业务窗口追加首条运行记录（成功）。 */
export function simulateScheduleRun(id: number, now: Date = new Date()): ScheduleActionResult {
  const config = findConfig(id)
  const invalid = ensureRunnable(config, id)
  if (invalid) return invalid
  const guarded = config as EntryRow
  const rows = loadRuns()
  const concurrency = checkConcurrency(guarded, rows)
  if (concurrency) return { ok: false, message: concurrency }
  const window = nextWindowOf(rows, guarded, now)
  const plan = buildRunPlan(guarded, [{ window, attempts: 0 }], WINDOW_SOURCE.SCHEDULE, '无冲突')
  const batchNo = makeBatchNo(now)
  const applied = appendPlan(rows, guarded, plan, RUN_RESULT.SUCCESS, now, batchNo)
  commitRows(applied.rows)
  return {
    ok: true,
    message: `定时调度已写入窗口「${window}」，批次号 ${batchNo}，调度运行记录表仅追加 1 条记录`,
    batchNo,
    processedWindows: [window],
    skippedWindows: [],
    appendedCount: applied.appended.length,
  }
}

/** 模拟该配置最近一个未完成窗口再超时一次，用于演示“重试上限与超时终态一起判断”。 */
export function simulateTimeout(id: number, now: Date = new Date()): ScheduleActionResult {
  const config = findConfig(id)
  const invalid = ensureRunnable(config, id)
  if (invalid) return invalid
  const guarded = config as EntryRow
  const rows = loadRuns()
  const configRows = runsOfConfig(rows, configCodeOf(guarded))
  if (!configRows.length) {
    return { ok: false, message: '该配置尚无任何窗口记录，请先执行定时调度生成窗口' }
  }
  const summaries = [...summarizeWindows(configRows, maxAttemptsOf(guarded)).values()]
  // 只对“最近一个未完成窗口”记超时：已完成窗口受去重保护，绝不补记失败。
  const target = summaries
    .filter((item) => !item.completed)
    .sort((a, b) => b.window.localeCompare(a.window))[0]
  if (!target) {
    return { ok: false, message: '该配置的窗口均已完成，去重保护拒绝再生成超时记录' }
  }
  const latestWindow = target.window
  if (target.finalFailed) {
    return { ok: false, message: `窗口「${latestWindow}」重试上限已用尽且为超时终态，失败补偿不再追加记录，可改用连续窗口补跑人工恢复` }
  }
  const plan = buildRunPlan(guarded, [target], WINDOW_SOURCE.SCHEDULE, '无冲突')
  const batchNo = makeBatchNo(now)
  const applied = appendPlan(rows, guarded, plan, RUN_RESULT.TIMEOUT, now, batchNo)
  commitRows(applied.rows)
  const created = applied.appended[0]
  const terminal = created && created['窗口状态'] === WINDOW_STATUS.FINAL_FAILED
  return {
    ok: true,
    message: terminal
      ? `窗口「${latestWindow}」本次超时且重试上限用尽，合并判定为终态失败，批次号 ${batchNo}`
      : `窗口「${latestWindow}」已记录第 ${plan[0].attempt} 次超时，仍在重试上限内，等待失败补偿，批次号 ${batchNo}`,
    batchNo,
    processedWindows: [latestWindow],
    skippedWindows: [],
    appendedCount: applied.appended.length,
  }
}

/** 失败窗口数据补偿：只读取并补跑“待补偿”窗口，已完成窗口绝不重新生成记录。 */
export function compensateFailedWindows(id: number, now: Date = new Date()): ScheduleActionResult {
  const config = findConfig(id)
  const invalid = ensureRunnable(config, id)
  if (invalid) return invalid
  const guarded = config as EntryRow
  const rows = loadRuns()
  const concurrency = checkConcurrency(guarded, rows)
  if (concurrency) return { ok: false, message: concurrency }
  const failed = selectFailedWindows(rows, guarded)
  if (!failed.length) {
    return { ok: false, message: `配置「${configCodeOf(guarded)}」没有待补偿的失败窗口，未写入任何记录` }
  }
  const plan = buildRunPlan(guarded, failed, WINDOW_SOURCE.COMPENSATE, '调度延迟重叠：仅补旧失败段，已完成窗口跳过')
  const batchNo = makeBatchNo(now)
  const applied = appendPlan(rows, guarded, plan, RUN_RESULT.SUCCESS, now, batchNo)
  commitRows(applied.rows)
  return {
    ok: true,
    message: `失败补偿完成，批次号 ${batchNo}：追加窗口 ${failed
      .map((item) => `「${item.window}」`)
      .join('、')} 的补跑记录；已完成窗口未重复生成`,
    batchNo,
    processedWindows: failed.map((item) => item.window),
    skippedWindows: applied.skippedKeys,
    appendedCount: applied.appended.length,
  }
}

/** 连续窗口补跑：从最早失败窗口起把后续连续窗口一并处理，已完成窗口只跳过并在冲突处理列留痕。 */
export function rerunContinuousWindows(id: number, now: Date = new Date()): ScheduleActionResult {
  const config = findConfig(id)
  const invalid = ensureRunnable(config, id)
  if (invalid) return invalid
  const guarded = config as EntryRow
  const rows = loadRuns()
  const concurrency = checkConcurrency(guarded, rows)
  if (concurrency) return { ok: false, message: concurrency }
  const { targets, skipped } = selectContinuousWindows(rows, guarded)
  if (!targets.length) {
    return {
      ok: false,
      message: skipped.length
        ? `后续窗口均已完成，去重保护未改写任何记录（跳过 ${skipped.length} 个已完成窗口）`
        : '没有需要连续补跑的窗口，未写入任何记录',
    }
  }
  const plan = buildRunPlan(guarded, targets, WINDOW_SOURCE.RERUN, '调度延迟重叠：连续窗口一并补跑，已完成窗口跳过不改写')
  const batchNo = makeBatchNo(now)
  const applied = appendPlan(rows, guarded, plan, RUN_RESULT.SUCCESS, now, batchNo)
  commitRows(applied.rows)
  return {
    ok: true,
    message:
      `连续补跑完成，批次号 ${batchNo}：追加窗口 ${targets.map((item) => `「${item.window}」`).join('、')} 的记录` +
      (skipped.length ? `；已完成窗口 ${skipped.map((item) => `「${item.window}」`).join('、')} 仅跳过未改写` : ''),
    batchNo,
    processedWindows: targets.map((item) => item.window),
    skippedWindows: skipped.map((item) => item.window),
    appendedCount: applied.appended.length,
  }
}

export function listScheduleRuns(filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(loadRuns(), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 导出清单与明细页共用同一份过滤结果和同一组列，保证“导出清单与明细页一致”。 */
export function exportScheduleRuns(filters: Record<string, string> = {}): { filename: string; content: string } {
  const { items } = listScheduleRuns(filters)
  const escapeCell = (value: unknown) => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [RUN_FIELDS.join(',')]
  for (const row of items) {
    lines.push(RUN_FIELDS.map((field) => escapeCell(row[field])).join(','))
  }
  return { filename: '调度运行记录-清单.csv', content: `﻿${lines.join('\n')}` }
}

/** 归档：调度运行记录表连同定时任务与调度配置快照一起打成一份归档文件，记录表状态只更新一次。 */
export function archiveScheduleRuns(now: Date = new Date()): { filename: string; content: string } {
  const rows = loadRuns()
  const stamp = formatTime(now)
  const archived = rows.map((row) =>
    row['归档标记'] === '已归档'
      ? row
      : { ...row, 归档标记: '已归档', 归档时间: stamp, status: row.status, pending: false, abnormal: row.abnormal },
  )
  // 归档状态与归档文件在同一次提交里落盘，仍然只写一份调度运行记录表。
  commitRows(archived)
  const payload = {
    归档时间: stamp,
    定时任务与调度配置: loadConfigs().map((config) => {
      const snapshot: Record<string, unknown> = { id: config.id, 当前状态: config.status }
      for (const field of ['配置编号', '关联任务', '调度表达式', '时区设定', '前置任务', '最大并发数', '失败重试策略', '超时终止']) {
        snapshot[field] = config[field]
      }
      return snapshot
    }),
    调度运行记录数据表: archived.map((row) => {
      const flat: Record<string, unknown> = {}
      for (const field of RUN_FIELDS) flat[field] = row[field]
      return flat
    }),
  }
  return {
    filename: `调度运行记录-归档-${stamp.replace(/[-: ]/g, '')}.json`,
    content: JSON.stringify(payload, null, 2),
  }
}

/** 调度运行记录概览，供页面统计卡片与状态图例复核。 */
export function scheduleRunStats(): {
  total: number
  openFailed: number
  finalFailed: number
  completed: number
  running: number
  unarchived: number
} {
  const rows = loadRuns()
  const count = (predicate: (row: ScheduleRunRow) => boolean) => rows.filter(predicate).length
  return {
    total: rows.length,
    openFailed: count((row) => row['窗口状态'] === WINDOW_STATUS.OPEN_FAILED),
    finalFailed: count((row) => row['窗口状态'] === WINDOW_STATUS.FINAL_FAILED),
    completed: count((row) => row['窗口状态'] === WINDOW_STATUS.COMPLETED),
    running: count((row) => row['窗口状态'] === WINDOW_STATUS.RUNNING),
    unarchived: count((row) => row['归档标记'] !== '已归档'),
  }
}
