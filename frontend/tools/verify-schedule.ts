/**
 * 调度失败补偿/重试去重验收脚本：node --import ./tools/alias-register.mjs --experimental-strip-types tools/verify-schedule.ts
 * 不参与前端构建，仅用 Node 原生 TS 类型擦除直跑，覆盖需求中的全部验收点。
 */
import assert from 'node:assert/strict'

import { resetRows, saveRows, listRows } from '../src/data/local-store.ts'
import { SEED_ROWS } from '../src/data/seed.ts'
import {
  archiveScheduleRuns,
  compensateFailedWindows,
  exportScheduleRuns,
  listScheduleRuns,
  rerunContinuousWindows,
  scheduleRunStats,
  simulateScheduleRun,
  simulateTimeout,
} from '../src/api/schedule/schedule-service.ts'
import { SCHEDULE_RUN_KEY, WINDOW_SOURCE, WINDOW_STATUS } from '../src/api/schedule/schedule-engine.ts'
import type { EntryRow, ScheduleRunRow } from '../src/data/types.ts'

const SCHE3 = 3
let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

function resetToSeed() {
  saveRows('schedule', JSON.parse(JSON.stringify(SEED_ROWS['schedule'])) as EntryRow[])
  saveRows(SCHEDULE_RUN_KEY, JSON.parse(JSON.stringify(SEED_ROWS[SCHEDULE_RUN_KEY])) as ScheduleRunRow[])
}

function runsOf(configCode: string): ScheduleRunRow[] {
  return (listRows(SCHEDULE_RUN_KEY) as ScheduleRunRow[]).filter((row) => row['配置编号'] === configCode)
}

function distinctAttempts(rows: ScheduleRunRow[], window: string): number {
  return new Set(rows.filter((r) => String(r['业务窗口']) === window).map((r) => Number(r['重试序号']))).size
}

console.log('S1 种子验收：SCHE-0003 的 08:00 已超时两次，09:00 已完成')
resetToSeed()
const seedRows = runsOf('SCHE-0003')
check('种子里 08:00 恰好两条超时尝试（两次）', () => {
  const w08 = seedRows.filter((r) => String(r['业务窗口']) === '2026-11-17 08:00')
  assert.equal(w08.length, 2)
  assert.ok(w08.every((r) => r['运行结果'] === '超时'))
})
check('种子里 09:00 已完成且只有一条记录', () => {
  const w09 = seedRows.filter((r) => String(r['业务窗口']) === '2026-11-17 09:00')
  assert.equal(w09.length, 1)
  assert.equal(w09[0]['运行结果'], '成功')
  assert.equal(w09[0]['窗口状态'], WINDOW_STATUS.COMPLETED)
})

console.log('S2 失败窗口数据补偿：只补 08:00，09:00 已完成窗口不重复生成')
const beforeCount = listScheduleRuns().total
const compensateResult = compensateFailedWindows(SCHE3)
check('补偿动作成功且只追加 1 条记录（单次提交一份表）', () => {
  assert.equal(compensateResult.ok, true)
  assert.equal(compensateResult.appendedCount, 1)
  assert.equal(listScheduleRuns().total, beforeCount + 1)
  assert.deepEqual(compensateResult.processedWindows, ['2026-11-17 08:00'])
})
const afterCompensate = runsOf('SCHE-0003')
check('08:00 补跑成功、窗口状态变已完成，窗口来源标注为失败补偿', () => {
  const w08 = afterCompensate.filter((r) => String(r['业务窗口']) === '2026-11-17 08:00')
  assert.equal(distinctAttempts(afterCompensate, '2026-11-17 08:00'), 3)
  assert.equal(w08.at(-1)!['运行结果'], '成功')
  assert.equal(w08.at(-1)!['窗口状态'], WINDOW_STATUS.COMPLETED)
  assert.equal(w08.at(-1)!['窗口来源'], WINDOW_SOURCE.COMPENSATE)
  assert.equal(Number(w08.at(-1)!['已重试次数']), 2)
})
check('09:00 已完成窗口未因补跑再次生成记录，仍是 1 条', () => {
  const w09 = afterCompensate.filter((r) => String(r['业务窗口']) === '2026-11-17 09:00')
  assert.equal(w09.length, 1)
})
check('没有待补偿窗口时再次补偿被拒绝且零写入', () => {
  const total = listScheduleRuns().total
  const again = compensateFailedWindows(SCHE3)
  assert.equal(again.ok, false)
  assert.equal(listScheduleRuns().total, total)
})

console.log('S3 重试上限与超时终态一起判断：第三次超时 → 终态失败')
resetToSeed()
const timeoutResult = simulateTimeout(SCHE3)
check('第三次超时后 08:00 合并判定为终态失败（重试2次=最多3次尝试）', () => {
  assert.equal(timeoutResult.ok, true)
  const w08 = runsOf('SCHE-0003').filter((r) => String(r['业务窗口']) === '2026-11-17 08:00')
  assert.equal(w08.length, 3)
  assert.equal(w08.at(-1)!['运行结果'], '超时')
  assert.equal(w08.at(-1)!['窗口状态'], WINDOW_STATUS.FINAL_FAILED)
  assert.equal(w08.at(-1)!.abnormal, true)
})
check('终态后模拟超时与失败补偿都拒绝追加，记录数不变', () => {
  const total = listScheduleRuns().total
  assert.equal(simulateTimeout(SCHE3).ok, false)
  assert.equal(compensateFailedWindows(SCHE3).ok, false)
  assert.equal(listScheduleRuns().total, total)
  const w08 = runsOf('SCHE-0003').filter((r) => String(r['业务窗口']) === '2026-11-17 08:00')
  assert.equal(w08.length, 3)
})
check('连续窗口补跑可人工恢复终态窗口，09:00 已完成窗口只跳过不改写', () => {
  const rerun = rerunContinuousWindows(SCHE3)
  assert.equal(rerun.ok, true)
  assert.deepEqual(rerun.processedWindows, ['2026-11-17 08:00'])
  assert.deepEqual(rerun.skippedWindows, ['2026-11-17 09:00'])
  const w08 = runsOf('SCHE-0003').filter((r) => String(r['业务窗口']) === '2026-11-17 08:00')
  assert.equal(w08.length, 4)
  assert.equal(w08.at(-1)!['窗口来源'], WINDOW_SOURCE.RERUN)
  const w09 = runsOf('SCHE-0003').filter((r) => String(r['业务窗口']) === '2026-11-17 09:00')
  assert.equal(w09.length, 1)
})

console.log('S4 并发补偿不能改写已完成记录：并发闸门 + 去重键双保险')
resetToSeed()
const runningRow: ScheduleRunRow = {
  id: 999,
  status: WINDOW_STATUS.RUNNING,
  pending: true,
  abnormal: false,
  记录编号: 'RUN-9001',
  配置编号: 'SCHE-0003',
  关联任务: '实时指标分钟聚合',
  业务窗口: '2026-11-17 10:00',
  窗口来源: WINDOW_SOURCE.SCHEDULE,
  重试序号: 0,
  已重试次数: 0,
  重试上限: 2,
  运行结果: '运行中',
  窗口状态: WINDOW_STATUS.RUNNING,
  前置任务读取: '无',
  批次号: 'BATCH-RUNNING',
  冲突处理: '无冲突',
  归档标记: '未归档',
  归档时间: '',
  配置快照: '{}',
  运行时间: '2026-11-17 10:00:00',
}
saveRows(SCHEDULE_RUN_KEY, [...(listRows(SCHEDULE_RUN_KEY) as ScheduleRunRow[]), runningRow])
check('最大并发数=1 且有运行中窗口时，调度/补偿/补跑全部零写入拒绝', () => {
  const total = listScheduleRuns().total
  assert.equal(simulateScheduleRun(SCHE3).ok, false)
  assert.equal(compensateFailedWindows(SCHE3).ok, false)
  assert.equal(rerunContinuousWindows(SCHE3).ok, false)
  assert.equal(listScheduleRuns().total, total)
})
check('并发窗口结束后补偿只追加失败窗口，运行中与已完成记录均不被改写', () => {
  const all = listRows(SCHEDULE_RUN_KEY) as ScheduleRunRow[]
  saveRows(
    SCHEDULE_RUN_KEY,
    all.map((row) => (row.id === 999 ? { ...row, 运行结果: '成功', 窗口状态: WINDOW_STATUS.COMPLETED, status: WINDOW_STATUS.COMPLETED, pending: false } : row)),
  )
  const result = compensateFailedWindows(SCHE3)
  assert.equal(result.ok, true)
  assert.deepEqual(result.processedWindows, ['2026-11-17 08:00'])
  const window10 = runsOf('SCHE-0003').filter((r) => String(r['业务窗口']) === '2026-11-17 10:00')
  assert.equal(window10.length, 1)
  assert.equal(window10[0]['运行结果'], '成功')
  const window09 = runsOf('SCHE-0003').filter((r) => String(r['业务窗口']) === '2026-11-17 09:00')
  assert.equal(window09.length, 1)
})

console.log('S5 调度延迟重叠：两种恢复策略都能恢复数据且留痕，流水线不会收到重复业务窗口')
resetToSeed()
const onlyOld = compensateFailedWindows(SCHE3)
check('做法一「只补旧失败段」：仅处理 08:00，冲突列写明跳过已完成窗口', () => {
  assert.deepEqual(onlyOld.processedWindows, ['2026-11-17 08:00'])
  const added = runsOf('SCHE-0003').find(
    (r) => String(r['业务窗口']) === '2026-11-17 08:00' && r['窗口来源'] === WINDOW_SOURCE.COMPENSATE,
  )!
  assert.match(String(added['冲突处理']), /仅补旧失败段/)
})
resetToSeed()
const rerun = rerunContinuousWindows(SCHE3)
check('做法二「连续窗口一并补跑」：08:00 补跑、09:00 跳过，两种做法留痕不同', () => {
  assert.deepEqual(rerun.processedWindows, ['2026-11-17 08:00'])
  assert.deepEqual(rerun.skippedWindows, ['2026-11-17 09:00'])
  const added = runsOf('SCHE-0003').find(
    (r) => String(r['业务窗口']) === '2026-11-17 08:00' && r['窗口来源'] === WINDOW_SOURCE.RERUN,
  )!
  assert.match(String(added['冲突处理']), /连续窗口一并补跑/)
})
check('两种策略后，每个业务窗口的成功记录都恰好一条，无重复批次', () => {
  for (const window of ['2026-11-17 08:00', '2026-11-17 09:00']) {
    const success = runsOf('SCHE-0003').filter((r) => String(r['业务窗口']) === window && r['运行结果'] === '成功')
    assert.equal(success.length, 1, `${window} 成功记录不唯一`)
    const batches = new Set(success.map((r) => r['批次号']))
    assert.equal(batches.size, 1)
  }
})

console.log('S6 前置任务读取、配置快照与归档')
resetToSeed()
const schedule = simulateScheduleRun(SCHE3)
check('定时调度读取前置任务后生成下一窗口（10:00）的首条成功记录', () => {
  assert.equal(schedule.ok, true)
  assert.deepEqual(schedule.processedWindows, ['2026-11-17 10:00'])
  const created = runsOf('SCHE-0003').find((r) => String(r['业务窗口']) === '2026-11-17 10:00')!
  assert.match(String(created['前置任务读取']), /SCHE-0002/)
  const snapshot = JSON.parse(String(created['配置快照'])) as Record<string, string>
  assert.equal(snapshot['配置编号'], 'SCHE-0003')
  assert.equal(snapshot['失败重试策略'], '重试2次')
  assert.equal(created['窗口来源'], WINDOW_SOURCE.SCHEDULE)
})
const archive = archiveScheduleRuns()
const archivePayload = JSON.parse(archive.content) as {
  定时任务与调度配置: unknown[]
  调度运行记录数据表: ScheduleRunRow[]
}
check('归档文件同时包含定时任务/调度配置与调度运行记录数据表', () => {
  assert.match(archive.filename, /^调度运行记录-归档-/)
  assert.ok(Array.isArray(archivePayload['定时任务与调度配置']))
  assert.equal(archivePayload['定时任务与调度配置'].length, 3)
  assert.ok(Array.isArray(archivePayload['调度运行记录数据表']))
  assert.equal(archivePayload['调度运行记录数据表'].length, listScheduleRuns().total)
})
check('归档只更新一次状态：全部记录标已归档且带归档时间', () => {
  assert.ok((listRows(SCHEDULE_RUN_KEY) as ScheduleRunRow[]).every((r) => r['归档标记'] === '已归档' && r['归档时间']))
  assert.equal(scheduleRunStats().unarchived, 0)
})

console.log('S7 导出清单与明细页一致')
const filtered = listScheduleRuns({ 配置编号: 'SCHE-0003' })
const exported = exportScheduleRuns({ 配置编号: 'SCHE-0003' })
check('导出条数等于明细页过滤结果，且表头与明细列一致', () => {
  const lines = exported.content.replace(/^﻿/, '').split('\n')
  assert.equal(lines.length - 1, filtered.total)
  assert.equal(lines[0], '记录编号,配置编号,关联任务,业务窗口,窗口来源,重试序号,已重试次数,重试上限,运行结果,窗口状态,前置任务读取,批次号,冲突处理,归档标记,归档时间,配置快照,运行时间')
})

console.log('S8 返回页面后数据仍可复核（localStorage 持久化）')
check('重新读取本地存储即可还原全部调度运行记录', () => {
  const reloaded = listScheduleRuns()
  assert.ok(reloaded.total >= 4)
  assert.ok(reloaded.items.some((r) => String(r['业务窗口']) === '2026-11-17 08:00'))
})

console.log(`\n全部 ${passed} 项验收通过`)
