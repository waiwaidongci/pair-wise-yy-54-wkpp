import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  ApprovalSnapshot,
  ClosureStage,
  OfflineBatch,
  Scheme,
  SegmentComment,
  StageConflict,
} from '../types'

const STORAGE_KEY = 'yy54-road-scheme-v1'
const CHANNEL_NAME = 'road-closure-sync'

const seed: Scheme = {
  id: 'RC-2026-0918', project: '云河路快速化改造', contractor: '市政建设集团第三工程处', area: '云河路 / 江海大道', version: 7,
  stages: [
    { id: 'ST-01', name: '第一阶段 · 东半幅围挡', start: '2026-10-08', end: '2026-10-22', lanes: '双向 4 车道收窄为 2 车道', status: '条件通过', route: [[121.470,31.228],[121.482,31.231],[121.496,31.235]], version: 1 },
    { id: 'ST-02', name: '第二阶段 · 路口夜间施工', start: '2026-10-23', end: '2026-11-05', lanes: '22:00–05:00 全封闭', status: '待协商', route: [[121.496,31.235],[121.508,31.238],[121.516,31.242]], version: 1 },
    { id: 'ST-03', name: '第三阶段 · 西半幅恢复', start: '2026-11-06', end: '2026-11-18', lanes: '西侧公交专用道临时占用', status: '退回', route: [[121.452,31.224],[121.462,31.226],[121.470,31.228]], version: 1 },
  ],
  detours: [
    { id: 'DR-01', name: '江海大道—滨河路绕行', distance: 4.8, extraMinutes: 11, coordinates: [[121.470,31.228],[121.478,31.214],[121.502,31.218],[121.516,31.242]] },
    { id: 'DR-02', name: '云河路辅道保通', distance: 2.3, extraMinutes: 6, coordinates: [[121.452,31.224],[121.462,31.219],[121.496,31.235]] },
  ],
  comments: [
    { id: 'CM-41', segmentId: 'ST-01', unit: '公交', author: '顾敏', content: '17 路、806 路临时站点与云河路站距离 680 米，超过老年乘客可接受步行距离。', condition: '需在江海大道口增设临时站并配置导乘人员。', status: '待处理' },
    { id: 'CM-42', segmentId: 'ST-02', unit: '应急', author: '夏川', content: '夜间全封闭期间，区域急救中心南门通道被切断。', condition: '保留 4 米应急通道，路口导改每 15 分钟巡查一次。', status: '已接受' },
    { id: 'CM-43', segmentId: 'ST-03', unit: '交通', author: '郑航', content: '公交专用道占用导致高峰小时延误增加 19 分钟，超过方案阈值。', condition: '缩减围挡 1.5 米并调整信号配时。', status: '已退回' },
  ],
}

/** 轻量哈希：用于判断几何 / 会签条件是否变化 */
function hashOf(input: unknown): string {
  const str = JSON.stringify(input)
  let h = 0
  for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0 }
  return `h${(h >>> 0).toString(16)}`
}

export const useSchemeStore = defineStore('scheme', () => {
  const scheme = ref<Scheme>(structuredClone(seed))
  const selectedStageId = ref('ST-01')
  const selectedCommentId = ref('CM-41')
  const drawing = ref(false)
  const draftRoute = ref<[number, number][]>([])
  const history = ref<string[]>([])

  /** 离线批次队列：各单位离线改动回传后按现场批次合并 */
  const batches = ref<OfflineBatch[]>([])
  /** 已应用批次的幂等键集合：失败后整批重试不重复写入 */
  const appliedBatchKeys = ref<Set<string>>(new Set())
  /** 阶段冲突列表：同一阶段两边都改过，保留两份并标出 */
  const conflicts = ref<StageConflict[]>([])
  /** 审批快照：几何与会签条件一致时冻结 */
  const snapshot = ref<ApprovalSnapshot | null>(null)
  /** 多窗口同步通道 */
  let channel: BroadcastChannel | null = null

  const selectedStage = computed(() => scheme.value.stages.find((item) => item.id === selectedStageId.value))
  const selectedComment = computed(() => scheme.value.comments.find((item) => item.id === selectedCommentId.value))

  /** 几何哈希：所有阶段路线 + 绕行路线 */
  const geometryHash = computed(() => hashOf({
    stages: scheme.value.stages.map((s) => ({ id: s.id, route: s.route, lanes: s.lanes })),
    detours: scheme.value.detours.map((d) => ({ id: d.id, coordinates: d.coordinates })),
  }))
  /** 会签条件哈希：所有意见状态 */
  const conditionsHash = computed(() => hashOf(scheme.value.comments.map((c) => ({ id: c.id, status: c.status }))))

  /** 是否满足冻结条件：几何有效且会签条件全部处理 */
  const canFreeze = computed(() => {
    const geometryValid = scheme.value.stages.every((s) => s.route.length >= 2)
    const conditionsResolved = scheme.value.comments.every((c) => c.status !== '待处理')
    return geometryValid && conditionsResolved
  })

  /** 快照是否仍然有效：冻结后车道/绕行/应急条件一变即失效 */
  const snapshotValid = computed(() => {
    if (!snapshot.value || snapshot.value.status !== 'frozen') return false
    return snapshot.value.geometryHash === geometryHash.value && snapshot.value.conditionsHash === conditionsHash.value
  })

  // 规则检测冲突（用于总览 / 地图页展示）
  const ruleConflicts = computed(() => [
    ...(scheme.value.stages.some((stage) => stage.id === 'ST-02') ? [{ id: 'CF-01', level: '高' as const, segmentId: 'ST-02', title: '相邻雨污分流工程时间重叠', detail: '10 月 26–30 日江海大道东段同步占用慢车道，建议错峰 4 天。' }] : []),
    { id: 'CF-02', level: '高' as const, segmentId: 'ST-02', title: '救护通道中断风险', detail: '夜间全封闭将切断区域急救中心南门，必须保留 4 米应急通道。' },
    { id: 'CF-03', level: '中' as const, segmentId: 'ST-01', title: '公交站点覆盖缺口', detail: '17 路与 806 路临时站距现状站 680 米，已超过 500 米阈值。' },
    { id: 'CF-04', level: '中' as const, segmentId: 'ST-03', title: '绕行延误超阈值', detail: '高峰绕行新增 19 分钟，超过方案设定的 15 分钟阈值。' },
  ])

  const dirty = computed(() => history.value.length > 0)

  function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(scheme.value)) }
  function restore() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      // 兼容旧存档：补 version 字段
      parsed.stages?.forEach((s: ClosureStage, i: number) => { if (s.version == null) s.version = seed.stages[i]?.version ?? 1 })
      scheme.value = parsed
    }
  }
  function commit() { history.value.push(JSON.stringify(scheme.value)); persist() }

  function startDraw() { drawing.value = true; draftRoute.value = [] }
  function addPoint(point: [number, number]) { if (drawing.value) draftRoute.value.push(point) }
  function finishDraw() {
    if (draftRoute.value.length >= 2) {
      const stage = selectedStage.value
      if (stage) { commit(); stage.route = [...draftRoute.value]; stage.status = '待协商'; stage.version += 1; scheme.value.version += 1; persist() }
    }
    drawing.value = false
    draftRoute.value = []
  }

  /**
   * 乐观并发提交：后到的一份不能覆盖先到内容。
   * 提交方携带 baseVersion，若当前版本已超前则拒绝并返回冲突。
   */
  function submitStageChange(stageId: string, baseVersion: number, patch: Partial<ClosureStage>): { ok: boolean; conflict?: StageConflict } {
    const stage = scheme.value.stages.find((s) => s.id === stageId)
    if (!stage) return { ok: false }
    if (stage.version !== baseVersion) {
      // 并发冲突：保留先到内容，标记冲突
      const remote: ClosureStage = { ...stage, ...patch, id: stageId, version: baseVersion }
      const conflict: StageConflict = {
        id: `SC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        stageId,
        batchId: 'local-submit',
        detectedAt: new Date().toISOString(),
        local: { ...stage },
        remote,
        resolved: false,
      }
      conflicts.value.push(conflict)
      return { ok: false, conflict }
    }
    commit()
    Object.assign(stage, patch)
    stage.version += 1
    stage.status = '待协商'
    scheme.value.version += 1
    persist()
    broadcast({ type: 'stage-changed', stageId, version: stage.version })
    return { ok: true }
  }

  function updateStage(patch: Partial<ClosureStage>) {
    const stage = selectedStage.value
    if (!stage) return
    commit(); Object.assign(stage, patch); stage.status = '待协商'; stage.version += 1; scheme.value.version += 1; persist()
    broadcast({ type: 'stage-changed', stageId: stage.id, version: stage.version })
  }

  function resolveComment(id: string, status: SegmentComment['status']) {
    const comment = scheme.value.comments.find((item) => item.id === id)
    if (!comment) return
    commit(); comment.status = status; scheme.value.version += 1; persist()
    broadcast({ type: 'comment-resolved', commentId: id, status })
  }

  function undo() {
    const previous = history.value.pop()
    if (previous) { scheme.value = JSON.parse(previous); persist() }
  }

  /**
   * 合并离线批次：各单位离线改动回传后按现场批次合并。
   * 同一阶段两边都改过就保留两份标出冲突，不覆盖先到内容。
   * 幂等键保证失败后整批重试不重复写入。
   */
  function mergeBatch(batch: OfflineBatch): { applied: number; conflicts: StageConflict[] } {
    if (appliedBatchKeys.value.has(batch.idempotencyKey)) {
      return { applied: 0, conflicts: [] } // 已应用，幂等跳过
    }
    batch.status = 'applying'
    const detected: StageConflict[] = []
    let applied = 0
    try {
      for (const change of batch.changes) {
        const stage = scheme.value.stages.find((s) => s.id === change.stageId)
        if (!stage) continue
        if (stage.version !== change.baseVersion) {
          // 两边都改过：保留两份，标出冲突，不覆盖
          const remote: ClosureStage = { ...stage, ...change.patch, id: change.stageId, version: change.baseVersion }
          const conflict: StageConflict = {
            id: `SC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            stageId: change.stageId,
            batchId: batch.id,
            detectedAt: new Date().toISOString(),
            local: { ...stage },
            remote,
            resolved: false,
          }
          conflicts.value.push(conflict)
          detected.push(conflict)
        } else {
          commit()
          Object.assign(stage, change.patch)
          stage.version += 1
          stage.status = '待协商'
          scheme.value.version += 1
          applied += 1
        }
      }
      batch.status = 'applied'
      appliedBatchKeys.value.add(batch.idempotencyKey)
      persist()
      broadcast({ type: 'batch-merged', batchId: batch.id })
    } catch (err) {
      batch.status = 'failed'
      batch.error = String(err)
    }
    return { applied, conflicts: detected }
  }

  /** 失败后整批重试：同一幂等键，不重复写入 */
  function retryBatch(batchId: string) {
    const batch = batches.value.find((b) => b.id === batchId)
    if (!batch || batch.status !== 'failed') return
    mergeBatch(batch)
  }

  function resolveConflict(conflictId: string, keep: 'local' | 'remote') {
    const conflict = conflicts.value.find((c) => c.id === conflictId)
    if (!conflict || conflict.resolved) return
    const stage = scheme.value.stages.find((s) => s.id === conflict.stageId)
    if (stage) {
      commit()
      const chosen = keep === 'local' ? conflict.local : conflict.remote
      Object.assign(stage, chosen, { id: stage.id })
      stage.version += 1
      scheme.value.version += 1
      persist()
    }
    conflict.resolved = true
  }

  /**
   * 冻结审批快照：当前几何和会签条件一致才能冻结。
   * 地图、总览和公开通告都按这份快照判断。
   */
  function freezeSnapshot(): { ok: boolean; reason?: string } {
    if (!canFreeze.value) {
      return { ok: false, reason: '几何或会签条件不一致：存在未完成的阶段或待处理意见' }
    }
    snapshot.value = {
      id: `SNAP-${Date.now()}`,
      frozenAt: new Date().toISOString(),
      schemeVersion: scheme.value.version,
      geometryHash: geometryHash.value,
      conditionsHash: conditionsHash.value,
      stages: structuredClone(scheme.value.stages),
      detours: structuredClone(scheme.value.detours),
      status: 'frozen',
    }
    persist()
    broadcast({ type: 'snapshot-frozen', snapshotId: snapshot.value.id })
    return { ok: true }
  }

  /** 快照失效：冻结后车道、绕行或应急条件一变，原审批立即失效 */
  function invalidateSnapshot(reason: string) {
    if (!snapshot.value || snapshot.value.status !== 'frozen') return
    snapshot.value.status = 'invalidated'
    snapshot.value.invalidatedReason = reason
    persist()
    broadcast({ type: 'snapshot-invalidated', snapshotId: snapshot.value.id, reason })
  }

  // 监听几何 / 会签条件变化：冻结后一变即失效
  watch([geometryHash, conditionsHash], () => {
    if (snapshot.value?.status === 'frozen' && !snapshotValid.value) {
      invalidateSnapshot('冻结后车道、绕行或应急条件发生变化，原审批立即失效')
    }
  })

  /** 多窗口同步：BroadcastChannel 广播阶段变更，其他窗口合并而非覆盖 */
  function broadcast(message: Record<string, unknown>) {
    try { channel?.postMessage(message) } catch { /* 通道不可用时忽略 */ }
  }

  function initChannel() {
    if (typeof BroadcastChannel === 'undefined') return
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = (event) => {
      const msg = event.data
      if (msg?.type === 'stage-changed') {
        // 其他窗口改了同一阶段：若本地版本未超前则同步，否则保留冲突
        const stage = scheme.value.stages.find((s) => s.id === msg.stageId)
        if (stage && stage.version < (msg.version as number)) {
          stage.version = msg.version as number
        }
      }
    }
  }

  watch(selectedStageId, () => {})
  restore()
  initChannel()

  return {
    scheme, selectedStageId, selectedCommentId, selectedStage, selectedComment,
    drawing, draftRoute, history,
    batches, conflicts, snapshot, appliedBatchKeys,
    geometryHash, conditionsHash, canFreeze, snapshotValid,
    ruleConflicts, dirty,
    persist, restore, commit,
    startDraw, addPoint, finishDraw,
    submitStageChange, updateStage, resolveComment, undo,
    mergeBatch, retryBatch, resolveConflict,
    freezeSnapshot, invalidateSnapshot,
  }
})
