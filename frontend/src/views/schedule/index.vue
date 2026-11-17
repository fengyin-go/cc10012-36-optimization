<template>
  <section class="page" data-module="schedule">
    <header class="page-head">
      <div>
        <h2>定时任务管理</h2>
        <p class="page-desc">维护调度配置的输入、执行约束与结果记录；失败窗口按业务窗口补偿去重，调度运行记录可复核、可归档。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记调度配置</button>
        <button class="btn" type="button" @click="exportRows">导出定时任务清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <h3 class="section-title">调度配置</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="scheduleAction('simulate', row)">定时调度</button>
            <button class="link" type="button" @click="scheduleAction('timeout', row)">模拟窗口超时</button>
            <button class="link" type="button" @click="scheduleAction('compensate', row)">失败窗口补偿</button>
            <button class="link" type="button" @click="scheduleAction('rerun', row)">连续窗口补跑</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无定时任务数据，可先登记调度配置</td>
        </tr>
      </tbody>
    </table>

    <div class="sub-head">
      <h3 class="section-title">调度运行记录表</h3>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRunRows">导出运行记录清单</button>
        <button class="btn" type="button" @click="archiveRuns">归档运行记录</button>
      </div>
    </div>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">运行记录总数</span>
        <strong class="stat-value">{{ runStats.total }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待补偿窗口（尝试次数）</span>
        <strong class="stat-value">{{ runStats.openFailed }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">终态失败窗口</span>
        <strong class="stat-value">{{ runStats.finalFailed }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已完成窗口</span>
        <strong class="stat-value">{{ runStats.completed }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">未归档记录</span>
        <strong class="stat-value">{{ runStats.unarchived }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reloadRuns">
      <label class="filter-item">
        <span>配置编号</span>
        <input v-model="runFilters['配置编号']" placeholder="按配置编号检索" />
      </label>
      <label class="filter-item">
        <span>业务窗口</span>
        <input v-model="runFilters['业务窗口']" placeholder="按业务窗口检索" />
      </label>
      <label class="filter-item">
        <span>窗口状态</span>
        <input v-model="runFilters['窗口状态']" placeholder="按窗口状态检索" />
      </label>
      <label class="filter-item">
        <span>窗口来源</span>
        <input v-model="runFilters['窗口来源']" placeholder="按窗口来源检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetRunFilters">重置条件</button>
    </form>

    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in runColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in runRows" :key="String(row.id)">
            <td v-for="column in runColumns" :key="column">{{ row[column] ?? '—' }}</td>
          </tr>
          <tr v-if="!runRows.length">
            <td :colspan="runColumns.length" class="empty-state">暂无调度运行记录，启用配置后执行定时调度生成窗口</td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条定时任务记录 · {{ runTotal }} 条调度运行记录（持久化在本地，返回页面后仍可复核）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="infoMessage" class="info-text">{{ infoMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  archiveScheduleRuns,
  compensateFailedWindows,
  exportScheduleRuns,
  listScheduleRuns,
  rerunContinuousWindows,
  RUN_FIELD_LIST,
  scheduleRunStats,
  simulateScheduleRun,
  simulateTimeout,
} from '@/api/schedule/schedule-service'
import type { EntryRow, ScheduleActionResult } from '@/data/types'

const meta = moduleMeta('schedule')
const columns = ['配置编号', '关联任务', '调度表达式', '时区设定', '前置任务', '最大并发数', '失败重试策略', '超时终止']
const actions = ['提交校验', '启用调度', '停用调度']
const statuses = ['草稿', '待校验', '已启用', '已停用']
const stats = [{ label: '调度配置总数', value: 0 }, { label: '已启用配置', value: 0 }, { label: '待校验配置', value: 0 }]
// 明细表与导出清单共用同一组列，保证两处口径一致。
const runColumns = RUN_FIELD_LIST

const rows = ref<EntryRow[]>([])
const total = ref(0)
const runRows = ref<EntryRow[]>([])
const runTotal = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const runFilters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const runStats = ref(scheduleRunStats())

function resetFilters() {
  filters.value = {}
  reload()
}

function resetRunFilters() {
  runFilters.value = {}
  reloadRuns()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportRunRows() {
  const { filename, content } = exportScheduleRuns(runFilters.value)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  infoMessage.value = `运行记录清单已导出（${runTotal.value} 条），列与本页明细表完全一致`
}

function archiveRuns() {
  const { filename, content } = archiveScheduleRuns()
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  infoMessage.value = `归档文件「${filename}」已生成，内含定时任务、调度配置与调度运行记录数据表`
  reloadRuns()
}

function openCreate() {
  errorMessage.value = '调度配置登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function scheduleAction(kind: 'simulate' | 'timeout' | 'compensate' | 'rerun', row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const handlers: Record<typeof kind, (id: number) => ScheduleActionResult> = {
    simulate: simulateScheduleRun,
    timeout: simulateTimeout,
    compensate: compensateFailedWindows,
    rerun: rerunContinuousWindows,
  }
  const result = handlers[kind](Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
  } else {
    infoMessage.value = result.message
  }
  reloadRuns()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '定时任务列表读取失败'
  }
}

function reloadRuns() {
  try {
    const payload = listScheduleRuns(runFilters.value)
    runRows.value = payload.items
    runTotal.value = payload.total
    runStats.value = scheduleRunStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '调度运行记录读取失败'
  }
}

onMounted(() => {
  reload()
  reloadRuns()
})
</script>

<style scoped>
.section-title {
  margin: 18px 0 8px;
  font-size: 15px;
}
.sub-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.table-scroll {
  overflow-x: auto;
  border: 1px solid var(--border);
}
.info-text {
  color: #1f6feb;
}
</style>
