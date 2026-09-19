import { readUiPreferences } from '@/stores/ui-preferences'
import { defineStore } from 'pinia'
import dayjs from 'dayjs'
import piniaPersistConfig from '@/stores/helper/persist'
import {
  beginManualSession,
  commitManualSession,
  getStatsOverview,
  getStatsTargets,
  recordManualSession,
  setStatsTargets,
} from '@/storage/local-write-stats'
import { ElMessage } from 'element-plus'

interface PanelPosition {
  x: number
  y: number
}

const formatNumber = (val: number) => Number.isFinite(val) ? val : 0

interface WritingPlanState {
  targetWords: number
  /** 进入写作页时账本里已入账的今日手写字数（不含本次会话），两种口径各一份 */
  todayBaseWords: number
  todayBaseTextWords: number
  todayWordsAvailable: boolean
  writingSeconds: number
  staySeconds: number
  idleSecondsTotal: number
  // 上一次 tick 的时间戳（ms）。用于在标签页后台/系统休眠导致 setInterval 被节流时，
  // 通过真实时间差补算停留/空闲时间，避免“切换应用/切换标签页计时暂停”。
  lastTickAt: number
  // 停留/空闲累积的毫秒余数（< 1000），用于把不满 1 秒的 deltaMs 留到下次合并计算。
  stayCarryMs: number
  idleCarryMs: number
  sessionWords: number
  sessionTextWords: number
  planPanelVisible: boolean
  settingsVisible: boolean
  panelPosition: PanelPosition
  summaryLoading: boolean
  isPageActive: boolean
  lastTypingAt: number
  editingGraceMs: number
  tickTimer: number | null
  reportTimer: number | null
  pendingStaySeconds: number
  pendingWritingSeconds: number
  pendingIdleSeconds: number
  bookId: string | number | null
  lastSummaryDate: string
  trackingStarted: boolean
}

export const useWritingPlanStore = defineStore('ew-writing-plan', {
  state: (): WritingPlanState => ({
    targetWords: 0,
    todayBaseWords: 0,
    todayBaseTextWords: 0,
    todayWordsAvailable: true,
    writingSeconds: 0,
    staySeconds: 0,
    idleSecondsTotal: 0,
    lastTickAt: 0,
    stayCarryMs: 0,
    idleCarryMs: 0,
    sessionWords: 0,
    sessionTextWords: 0,
    planPanelVisible: false,
    settingsVisible: false,
    panelPosition: { x: 32, y: 120 } as PanelPosition,
    summaryLoading: false,
    isPageActive: true,
    lastTypingAt: 0,
    editingGraceMs: 2500,
    tickTimer: null as number | null,
    reportTimer: null as number | null,
    pendingStaySeconds: 0,
    pendingWritingSeconds: 0,
    pendingIdleSeconds: 0,
    bookId: null as string | number | null,
    lastSummaryDate: '',
    trackingStarted: false,
  }),
  getters: {
    /** 今日已写 = 已入账 + 本次会话净增，与账本口径完全一致，任何时刻重读都不会跳变 */
    todayWords(state): number {
      return readUiPreferences().wordCountMode === 'text'
        ? state.todayBaseTextWords + state.sessionTextWords
        : state.todayBaseWords + state.sessionWords
    },
    planProgress(): number {
      if (!this.todayWordsAvailable || !this.targetWords) return 0
      if (!this.todayWords) return 0
      return Math.min(100, Math.round((this.todayWords / this.targetWords) * 100))
    },
    remainingWords(): number {
      if (!this.todayWordsAvailable || !this.targetWords) return 0
      return Math.max(this.targetWords - this.todayWords, 0)
    },
    idleSeconds(state): number {
      return Math.max(state.idleSecondsTotal, 0)
    }
  },
  actions: {
    async bootstrap(bookId?: string | number) {
      this.bookId = bookId ?? null
      // 上一次会话（含异常退出没来得及入账的）先并入账本，本次从 0 起算
      beginManualSession()
      this.pendingStaySeconds = 0
      this.pendingWritingSeconds = 0
      this.pendingIdleSeconds = 0
      this.resetSessionStats()
      await this.fetchSummary()
      this.isPageActive = !document.hidden
      this.lastTickAt = Date.now()
      this.startTick()
      this.startReportLoop()
    },
    stopTimers() {
      if (this.tickTimer) {
        clearInterval(this.tickTimer)
        this.tickTimer = null
      }
      if (this.reportTimer) {
        clearInterval(this.reportTimer)
        this.reportTimer = null
      }
    },
    ensureTimersRunning() {
      if (!this.tickTimer) {
        this.lastTickAt = Date.now()
        this.startTick()
      }
      this.startReportLoop()
    },
    async fetchSummary(date?: string) {
      if (this.summaryLoading) return
      this.summaryLoading = true
      try {
        const targetDate = date || dayjs().format('YYYY-MM-DD')
        this.lastSummaryDate = targetDate
        // 开源版：计划数据来自本地码字账本，目标与今日字数都取古法口径
        this.targetWords = formatNumber(getStatsTargets().manual)
        // 先把本次会话写进账本，再读总数并减掉会话部分，得到"已入账"基数；
        // 这样重读前后 todayWords 恒等于 基数 + 会话，不会跳变
        await this.flushReport(true)
        const allWords = getStatsOverview(targetDate, undefined, 'all').manualWords
        const textWords = getStatsOverview(targetDate, undefined, 'text').manualWords
        this.todayBaseWords = Math.max(0, formatNumber(allWords ?? 0) - this.sessionWords)
        this.todayBaseTextWords = Math.max(0, formatNumber(textWords ?? 0) - this.sessionTextWords)
        const current = readUiPreferences().wordCountMode === 'text' ? textWords : allWords
        this.todayWordsAvailable = current !== null
      } finally {
        this.summaryLoading = false
      }
    },
    addWords(count: number, textCount = 0) {
      this.ensureTimersRunning()
      const previousAll = this.sessionWords
      const previousText = this.sessionTextWords
      // 会话净增不低于 0：删掉的是本次会话之前的旧字时不扣，今日已写由 getter 按 基数 + 会话 得出
      this.sessionWords = Math.max(0, previousAll + Math.trunc(Number(count) || 0))
      this.sessionTextWords = Math.max(0, previousText + Math.trunc(Number(textCount) || 0))
    },
    notifyTyping() {
      this.ensureTimersRunning()
      this.lastTypingAt = Date.now()
      if (!this.trackingStarted) {
        this.trackingStarted = true
      }
    },
    setPageActive(val: boolean) {
      this.isPageActive = val
      if (!val) {
        // 页面不可见/失焦时：不暂停、不清零（计时继续累计）。
        // 这里仅做一次强制上报，避免用户长时间离开后本地累积过多未上报数据。
        // 会话清零仅在离开写作页面（teardown）时发生。
        void this.flushReport(true)
      }
    },
    setPanelVisible(val: boolean) {
      this.planPanelVisible = val
    },
    togglePanel() {
      this.planPanelVisible = !this.planPanelVisible
    },
    setPanelPosition(pos: PanelPosition) {
      this.panelPosition = pos
    },
    openSettings() {
      this.settingsVisible = true
    },
    closeSettings() {
      this.settingsVisible = false
    },
    async submitTarget(target: number) {
      setStatsTargets({ manual: target, ai: getStatsTargets().ai })
      this.targetWords = target
      this.settingsVisible = false
      ElMessage.success('已更新写作计划')
    },
    resetSessionStats() {
      this.sessionWords = 0
      this.sessionTextWords = 0
      this.writingSeconds = 0
      this.staySeconds = 0
      this.idleSecondsTotal = 0
      this.lastTickAt = 0
      this.stayCarryMs = 0
      this.idleCarryMs = 0
      this.trackingStarted = false
      this.lastTypingAt = 0
    },
    startTick() {
      if (this.tickTimer) return
      this.tickTimer = window.setInterval(() => {
        const now = Date.now()
        const prevTickAt = this.lastTickAt || now
        const deltaMs = Math.max(0, now - prevTickAt)
        this.lastTickAt = now

        if (!this.trackingStarted) {
          // 还没开始码字（未触发 notifyTyping）前，不累计任何时间。
          // 同时清空 carry，避免下次开始时“继承”旧的毫秒余数。
          this.stayCarryMs = 0
          this.idleCarryMs = 0
          return
        }
        // 停留耗时：从敲下第一个字开始计时（包含停顿时间）。
        // 采用 deltaMs -> 秒 的方式，保证后台节流/休眠唤醒后也能正确累计。
        const stayMs = this.stayCarryMs + deltaMs
        const stayAddSeconds = Math.floor(stayMs / 1000)
        this.stayCarryMs = stayMs % 1000
        if (stayAddSeconds > 0) {
          this.staySeconds += stayAddSeconds
          this.pendingStaySeconds += stayAddSeconds
        }

        // 空闲时间：停顿达到 2 秒后开始计时；开始码字后暂停。
        // idleStartAt = (最后一次输入时间 + 2s)，只有 now 超过该阈值，才累计 idle。
        const idleStartAt = this.lastTypingAt + 2000
        const idleDeltaMs = now > idleStartAt ? Math.max(0, now - Math.max(prevTickAt, idleStartAt)) : 0
        const idleMs = this.idleCarryMs + idleDeltaMs
        const idleAddSeconds = Math.floor(idleMs / 1000)
        this.idleCarryMs = idleMs % 1000
        if (idleAddSeconds > 0) {
          this.idleSecondsTotal += idleAddSeconds
          this.pendingIdleSeconds += idleAddSeconds
        }

        // 码字时间：净“停留时间 - 空闲时间”。
        // 空闲时间按“停顿超过 2 秒”才开始累计，所以写作时间会在停顿超过 2 秒后逐渐停止增长。
        this.writingSeconds = Math.max(this.staySeconds - this.idleSecondsTotal, 0)
      }, 1000)
    },
    startReportLoop() {
      if (this.reportTimer) return
      this.reportTimer = window.setInterval(() => {
        this.flushReport().catch(err => console.error('flush report failed', err))
      }, 30000)
    },
    async flushReport(_force = false) {
      // 开源版无服务端上报：把本次会话净增覆盖写入账本的会话槽位（幂等），时间类待报量清空
      if (this.bookId != null) recordManualSession(this.bookId, this.sessionWords, this.sessionTextWords)
      this.pendingStaySeconds = 0
      this.pendingWritingSeconds = 0
      this.pendingIdleSeconds = 0
      return true
    },
    async teardown() {
      this.stopTimers()
      await this.flushReport(true)
      // 本次会话正式入账，下次进入从 0 起算
      commitManualSession()
      this.resetSessionStats()
    }
  },
  persist: piniaPersistConfig('ew-writing-plan', ['panelPosition'])
})
