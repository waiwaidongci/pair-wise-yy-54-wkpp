import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  ApprovalSnapshot, ChangeBatch, ClosureStage, DetourRoute, FaultMode, MergeConflict,
  OfflineChange, SegmentComment, ServerLogEntry, SnapshotGate, Unit,
} from '../types'
import { conditionHash, fieldLabel, geometryHash, isInvalidatingField, uid, valueText } from '../lib/sync'
import {
  adminCommit, deterministicConflictId, freezeSnapshot as serverFreeze,
  invalidateSnapshot as serverInvalidate, initServer, loadServer, resetServer, save,
  submitBatch as serverSubmit, type ServerState,
} from '../lib/mockServer'

const CLIENT_KEY = 'yy54-road-client-v2'
const CHANNEL = 'yy54-road-sync'

const seed: { scheme: import('../types').Scheme } = {
  scheme: {
    id: 'RC-2026-0918', project: '云河路快速化改造', contractor: '市政建设集团第三工程处', area: '云河路 / 江海大道', version: 7,
    stages: [
      { id: 'ST-01', name: '第一阶段 · 东半幅围挡', start: '2026-10-08', end: '2026-10-22', lanes: '双向 4 车道收窄为 2 车道', status: '待协商', route: [[121.47, 31.228], [121.482, 31.231], [121.496, 31.235]] },
      { id: 'ST-02', name: '第二阶段 · 路口夜间施工', start: '2026-10-23', end: '2026-11-05', lanes: '22:00–05:00 全封闭', status: '待协商', route: [[121.496, 31.235], [121.508, 31.238], [121.516, 31.242]] },
      { id: 'ST-03', name: '第三阶段 · 西半幅恢复', start: '2026-11-06', end: '2026-11-18', lanes: '西侧公交专用道临时占用', status: '退回', route: [[121.452, 31.224], [121.462, 31.226], [121.47, 31.228]] },
    ],
    detours: [
      { id: 'DR-01', name: '江海大道—滨河路绕行', distance: 4.8, extraMinutes: 11, coordinates: [[121.47, 31.228], [121.478, 31.214], [121.502, 31.218], [121.516, 31.242]] },
      { id: 'DR-02', name: '云河路辅道保通', distance: 2.3, extraMinutes: 6, coordinates: [[121.452, 31.224], [121.462, 31.219], [121.496, 31.235]] },
    ],
    comments: [
      { id: 'CM-41', segmentId: 'ST-01', unit: '公交', author: '顾敏', content: '17 路、806 路临时站点与云河路站距离 680 米，超过老年乘客可接受步行距离。', condition: '需在江海大道口增设临时站并配置导乘人员。', status: '待处理' },
      { id: 'CM-42', segmentId: 'ST-02', unit: '应急', author: '夏川', content: '夜间全封闭期间，区域急救中心南门通道被切断。', condition: '保留 4 米应急通道，路口导改每 15 分钟巡查一次。', status: '已接受' },
      { id: 'CM-43', segmentId: 'ST-03', unit: '交通', author: '郑航', content: '公交专用道占用导致高峰小时延误增加 19 分钟，超过方案阈值。', condition: '缩减围挡 1.5 米并调整信号配时。', status: '已退回' },
    ],
  },
}

interface ClientPrefs {
  online: boolean
  currentUnit: Unit
  fault: FaultMode
  history: string[]
}

function loadPrefs(): ClientPrefs {
  const raw = localStorage.getItem(CLIENT_KEY)
  if (raw) return JSON.parse(raw) as ClientPrefs
  return { online: true, currentUnit: '建设', fault: 'none', history: [] }
}

function now(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

export const useSchemeStore = defineStore('scheme', () => {
  // 服务端权威状态（localStorage 模拟，跨标签页共享）
  let server: ServerState = loadServer() ?? initServer(seed.scheme)
  const prefs = ref<ClientPrefs>(loadPrefs())
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null

  // 以服务器状态为客户端工作集
  const scheme = ref(structuredClone(server.scheme))
  const revision = ref(server.revision)
  const conflicts = ref<MergeConflict[]>(structuredClone(server.conflicts))
  const snapshots = ref<ApprovalSnapshot[]>(structuredClone(server.snapshots))
  const serverLogs = ref<ServerLogEntry[]>(structuredClone(server.logs))
  const batches = ref<ChangeBatch[]>(structuredClone(server.batches))

  const selectedStageId = ref('ST-01')
  const selectedCommentId = ref('CM-41')
  const drawing = ref(false)
  const draftRoute = ref<[number, number][]>([])
  const online = ref(prefs.value.online)
  const currentUnit = ref<Unit>(prefs.value.currentUnit)
  const faultMode = ref<FaultMode>(prefs.value.fault)
  const history = ref<string[]>(prefs.value.history)
  const lastError = ref('')

  function savePrefs() {
    localStorage.setItem(CLIENT_KEY, JSON.stringify({ online: online.value, currentUnit: currentUnit.value, fault: faultMode.value, history: history.value }))
  }

  /** 从权威状态整体同步本地工作集 */
  function hydrate() {
    const latest = loadServer()
    if (latest) server = latest
    scheme.value = structuredClone(server.scheme)
    revision.value = server.revision
    conflicts.value = structuredClone(server.conflicts)
    snapshots.value = structuredClone(server.snapshots)
    serverLogs.value = structuredClone(server.logs)
    batches.value = structuredClone(server.batches)
  }

  // 其他标签页提交后，本页不覆盖、只拉取
  channel?.addEventListener('message', (event: MessageEvent<string>) => {
    if (event.data === 'committed') hydrate()
  })
  window.addEventListener('storage', (event) => {
    if (event.key === 'yy54-road-server-v2') hydrate()
  })

  function announce() {
    channel?.postMessage('committed')
  }

  const pendingConflicts = computed(() => conflicts.value.filter((c) => c.status === '待裁定'))
  const activeSnapshot = computed(() => snapshots.value.filter((s) => s.valid).at(-1))
  const invalidSnapshot = computed(() => snapshots.value.find((s) => !s.valid && s.id === snapshots.value.at(-1)?.id))

  const selectedStage = computed(() => scheme.value.stages.find((item) => item.id === selectedStageId.value))
  const selectedComment = computed(() => scheme.value.comments.find((item) => item.id === selectedCommentId.value))

  const staticConflicts = computed(() => [
    { id: 'RC-01', level: '高', segmentId: 'ST-02', title: '相邻雨污分流工程时间重叠', detail: '10 月 26–30 日江海大道东段同步占用慢车道，建议错峰 4 天。' },
    { id: 'RC-02', level: '高', segmentId: 'ST-02', title: '救护通道中断风险', detail: '夜间全封闭将切断区域急救中心南门，必须保留 4 米应急通道。' },
    { id: 'RC-03', level: '中', segmentId: 'ST-01', title: '公交站点覆盖缺口', detail: '17 路与 806 路临时站距现状站 680 米，已超过 500 米阈值。' },
    { id: 'RC-04', level: '中', segmentId: 'ST-03', title: '绕行延误超阈值', detail: '高峰绕行新增 19 分钟，超过方案设定的 15 分钟阈值。' },
  ])

  const dirty = computed(() => history.value.length > 0)

  // ---------- 派生：合并冲突导致的阶段状态 ----------
  function stageStatus(stageId: string): ClosureStage['status'] {
    if (activeSnapshot.value) {
      return activeSnapshot.value.stages.find((s) => s.id === stageId)?.status ?? '待协商'
    }
    const stageConflicts = pendingConflicts.value.filter((c) => c.stageId === stageId)
    if (stageConflicts.length > 0) return '冲突待裁'
    const stageComments = scheme.value.comments.filter((c) => c.segmentId === stageId)
    if (stageComments.some((c) => c.status === '已退回')) return '退回'
    if (stageComments.length > 0 && stageComments.every((c) => c.status === '已接受')) return '条件通过'
    return '待协商'
  }

  // ---------- 冻结闸门：当前几何与会签条件一致 ----------
  const freezeGates = computed<SnapshotGate[]>(() => {
    const gates: SnapshotGate[] = []
    const pending = scheme.value.comments.filter((c) => c.status === '待处理')
    gates.push({
      key: 'pending', label: '会签条件全部闭合', passed: pending.length === 0,
      hint: pending.length === 0 ? '无待处理意见' : `${pending.map((c) => c.id).join('、')} 仍为待处理`,
    })
    const drift = scheme.value.comments
      .filter((c) => c.status === '已接受' && c.anchoredHash)
      .filter((c) => {
        const stage = scheme.value.stages.find((s) => s.id === c.segmentId)
        return stage && geometryHash(stage) !== c.anchoredHash
      })
    gates.push({
      key: 'drift', label: '接受时锚定几何 = 当前几何', passed: drift.length === 0,
      hint: drift.length === 0 ? '所有已接受条件锚定的几何均未漂移' : `${drift.map((c) => `${c.segmentId}/${c.unit}`).join('、')} 条件接受后几何又变过`,
    })
    gates.push({
      key: 'returned', label: '无退回待改阶段',
      passed: !scheme.value.comments.some((c) => c.status === '已退回'),
      hint: scheme.value.comments.some((c) => c.status === '已退回') ? '交通单位对 ST-03 的条件处于退回状态' : '无退回意见',
    })
    gates.push({
      key: 'merge', label: '离线合并无未裁定冲突', passed: pendingConflicts.value.length === 0,
      hint: pendingConflicts.value.length === 0 ? '现场批次已全部消解' : `${pendingConflicts.value.length} 条双份冲突等待裁定`,
    })
    return gates
  })
  const canFreeze = computed(() => freezeGates.value.every((g) => g.passed))

  // ---------- 在线编辑：单条 CAS 提交 ----------
  function pushOnlineChange(change: Omit<OfflineChange, 'id' | 'unit'>): boolean {
    const full: OfflineChange = { ...change, id: uid('CH'), unit: currentUnit.value }
    const batch: ChangeBatch = {
      id: uid('BX'), unit: currentUnit.value, source: '在线编辑',
      baseRevision: revision.value, mode: 'online-cas', status: '提交中', attempts: 1,
      createdAt: now(), changes: [{ ...full, base: server.targetRev[full.targetId] ?? revision.value }], conflictIds: [],
    }
    history.value.push(JSON.stringify(server.scheme))
    // 先把批次登记进权威批次表：确认丢失后重试时可定位同一批次，命中幂等
    server = { ...server, batches: [batch, ...server.batches] }
    save(server)
    try {
      const { result, state } = serverSubmit(server, batch)
      if (result.outcome === 'stale') {
        history.value.pop()
        let next = state
        const staleBatch = next.batches.find((b) => b.id === batch.id)
        if (staleBatch) {
          staleBatch.status = '已拒绝'
          staleBatch.submittedAt = now()
          staleBatch.resultNote = `基线 r${batch.baseRevision} 过期，后到一份未覆盖先到内容，可 rebase 后重试`
        }
        save(next)
        server = next
        lastError.value = `并发保护：${change.label} 已被另一窗口先行提交（服务端 r${result.staleTargets?.[0]?.serverRevision}，先到值：「${result.staleTargets?.[0]?.serverText}」），后到内容未覆盖。可在批次页 rebase 到最新基线后整批重试。`
        hydrate(); announce()
        return false
      }
      let next = state
      const okBatch = next.batches.find((b) => b.id === batch.id)
      if (okBatch) { okBatch.status = '已合并'; okBatch.submittedAt = now(); okBatch.resultNote = 'CAS 快进合并' }
      next = invalidateIfNeeded(batch.changes, next)
      save(next)
      server = next
      hydrate(); savePrefs(); announce()
      lastError.value = ''
      return true
    } catch (error) {
      // 弱网失败：本端不知道是否已落库 → 不改动工作集；批次保留，整批重试走幂等，不重复写入
      const stored = loadServer()
      if (stored) server = stored
      const pending = server.batches.find((b) => b.id === batch.id)
      if (pending) { pending.status = '失败待重试'; pending.resultNote = (error as Error).message; save(server) }
      const recorded = server.batchResults[batch.id]
      lastError.value = recorded
        ? `确认丢失但批次已落库（${recorded.outcome === 'merged' ? '已合并' : '已拒绝'}），请整批重试验证幂等，不会重复写入`
        : `提交未到达服务器（${(error as Error).message}），数据未写入，可整批重试`
      hydrate(); announce()
      return false
    }
  }

  /** 成功写入后：车道 / 绕行 / 应急条件一变，原审批立即失效 */
  function invalidateIfNeeded(changes: OfflineChange[], state: ServerState): ServerState {
    if (!state.snapshots.some((s) => s.valid)) return state
    const reasonParts: string[] = []
    const scope = new Set<string>()
    changes.forEach((ch) => {
      const reason = (() => {
        if (ch.target === 'stage' && isInvalidatingField(ch.target, ch.field)) {
          scope.add(ch.targetId); return `阶段 ${ch.targetId} 的${fieldLabel(ch.field)}被${ch.unit}单位修改`
        }
        if (ch.target === 'detour') {
          const stageIds = state.scheme.stages.map((s) => s.id)
          stageIds.forEach((id) => scope.add(id))
          return `绕行方案 ${ch.targetId} 被${ch.unit}单位修改`
        }
        if (ch.target === 'comment' && (ch.field === 'condition' || ch.field === 'status')) {
          const comment = state.scheme.comments.find((c) => c.id === ch.targetId)
          if (comment?.unit === '应急') {
            scope.add(comment.segmentId)
            return `应急会签条件（${ch.targetId}）被${ch.unit}单位修改`
          }
        }
        return null
      })()
      if (reason) reasonParts.push(reason)
    })
    if (reasonParts.length === 0) return state
    return serverInvalidate(state, reasonParts.join('；'), [...scope])
  }

  // ---------- 离线：改动进入本单位的现场批次（一个单位一个在途批次） ----------
  function queueOfflineChange(change: Omit<OfflineChange, 'id' | 'unit'>): ChangeBatch {
    const full: OfflineChange = { ...change, id: uid('CH'), unit: currentUnit.value }
    const existing = server.batches
      .filter((b) => b.mode === 'offline-merge' && b.unit === currentUnit.value && b.status === '待回传')
      .at(0)
    if (existing) {
      existing.changes.push(full)
      save(server)
      hydrate()
      lastError.value = ''
      return existing
    }
    const batch: ChangeBatch = {
      id: uid('BT'), unit: currentUnit.value, source: '离线现场',
      baseRevision: revision.value, mode: 'offline-merge', status: '待回传', attempts: 0,
      createdAt: now(), changes: [full], conflictIds: [],
    }
    server = { ...server, batches: [batch, ...server.batches] }
    save(server)
    hydrate()
    lastError.value = ''
    return batch
  }

  function fieldBase(ch: { target: OfflineChange['target']; targetId: string; field: string }): number {
    return server.fieldRev[`${ch.targetId}::${ch.field}`] ?? revision.value
  }

  function applyChange(change: Omit<OfflineChange, 'id' | 'unit'>) {
    lastError.value = ''
    if (!online.value) {
      // 离线改动记录字段级基线，回传时只有同一字段两边都改才保留双份
      queueOfflineChange({ ...change, base: fieldBase(change) })
      return
    }
    pushOnlineChange(change)
  }

  function updateStage(patch: Partial<ClosureStage>) {
    const stage = selectedStage.value
    if (!stage) return
    Object.entries(patch).forEach(([field, value]) => {
      applyChange({ target: 'stage', targetId: stage.id, field, value, label: `${stage.id} ${fieldLabel(field)}`, valueText: valueText(value) })
    })
  }

  function updateDetour(id: string, patch: Partial<DetourRoute>) {
    Object.entries(patch).forEach(([field, value]) => {
      applyChange({ target: 'detour', targetId: id, field, value, label: `${id} ${fieldLabel(field)}`, valueText: valueText(value) })
    })
  }

  function startDraw() { drawing.value = true; draftRoute.value = [] }
  function addPoint(point: [number, number]) { if (drawing.value) draftRoute.value.push(point) }
  function finishDraw() {
    if (draftRoute.value.length >= 2 && selectedStage.value) {
      applyChange({ target: 'stage', targetId: selectedStage.value.id, field: 'route', value: [...draftRoute.value], label: `${selectedStage.value.id} 封路几何`, valueText: valueText([...draftRoute.value]) })
    }
    drawing.value = false
    draftRoute.value = []
  }

  function resolveComment(id: string, status: SegmentComment['status']) {
    const comment = scheme.value.comments.find((item) => item.id === id)
    if (!comment) return
    applyChange({ target: 'comment', targetId: id, field: 'status', value: status, label: `${id} 会签结论→${status}`, valueText: status })
    if (status === '已接受') {
      const stage = scheme.value.stages.find((s) => s.id === comment.segmentId)
      if (stage) {
        const anchored = geometryHash(stage)
        applyChange({ target: 'comment', targetId: id, field: 'anchoredHash', value: anchored, label: `${id} 锚定几何`, valueText: anchored.slice(0, 8) })
      }
    }
  }

  /** 重新打开已闭合的意见（可再次接受 / 退回），保证冻结闸门可达 */
  function reopenComment(id: string) {
    const comment = scheme.value.comments.find((item) => item.id === id)
    if (!comment || comment.status === '待处理') return
    applyChange({ target: 'comment', targetId: id, field: 'status', value: '待处理', label: `${id} 重新提请会签`, valueText: '待处理' })
  }

  /** 修订会签条件（应急条件变化是冻结后审批失效的触发源之一） */
  function reviseCommentCondition(id: string, condition: string) {
    const comment = scheme.value.comments.find((item) => item.id === id)
    if (!comment) return
    applyChange({ target: 'comment', targetId: id, field: 'condition', value: condition, label: `${id} 修订${comment.unit}条件`, valueText: condition })
  }

  // ---------- 批次回传 / 重试 / 取消 ----------
  function discardBatch(batchId: string) {
    batches.value = batches.value.filter((b) => b.id !== batchId)
    server = { ...server, batches: server.batches.filter((b) => b.id !== batchId) }
    save(server)
    hydrate()
  }

  /** 批次提交（离线回传用 offline-merge 语义）。原子事务，失败整批重试，重试不重复写入 */
  function submitBatchTransaction(batchId: string) {
    const local = server.batches.find((b) => b.id === batchId)
    if (!local) return
    const batch: ChangeBatch = { ...structuredClone(local), status: '提交中', attempts: local.attempts + 1, submittedAt: now() }
    let outcome: Awaited<ReturnType<typeof serverSubmit>> | undefined
    try {
      outcome = serverSubmit(server, batch)
    } catch (error) {
      // 整批失败：批次保持可重试，不写入任何冲突 / 应用记录
      const fresh = loadServer()
      if (fresh) server = fresh
      const stored = server.batches.find((b) => b.id === batchId)
      if (stored) {
        stored.status = '失败待重试'
        stored.attempts = batch.attempts
        stored.resultNote = (error as Error).message
        save(server)
      }
      lastError.value = `批次 ${batchId} 提交失败（${(error as Error).message}），数据未写入，可整批重试`
      hydrate(); announce()
      return
    }
    const { result, state, idempotentRetry } = outcome
    let next = state
    if (result.outcome === 'merged') {
      next = invalidateIfNeeded(batch.changes, next)
      // 登记双份冲突（幂等：deterministicConflictId 去重；lostAck 重放同样安全）
      result.conflicts.forEach((raw) => {
        const cid = deterministicConflictId(raw.changeId)
        if (!next.conflicts.some((c) => c.id === cid)) {
          next.conflicts.unshift({
            id: cid, changeId: raw.changeId, batchId: raw.batchId, stageId: raw.stageId,
            target: raw.target, targetId: raw.targetId, field: raw.field, fieldLabel: fieldLabel(raw.field),
            localLabel: '先入库（其他窗口 / 单位）', remoteLabel: `${batch.unit}单位现场批次`,
            localText: raw.localText, remoteText: raw.remoteText, status: '待裁定', createdAt: now(),
          })
        }
      })
    }
    // 回写批次状态（重放时保持幂等语义）
    const stored = next.batches.find((b) => b.id === batchId)
    if (stored) {
      stored.status = result.outcome === 'merged' ? '已合并' : '已拒绝'
      stored.attempts = batch.attempts
      stored.submittedAt = batch.submittedAt
      stored.resultNote = idempotentRetry ? `第 ${batch.attempts} 次提交命中幂等记录，未重复写入` : result.outcome === 'merged'
        ? `应用 ${result.appliedIds.length} 条，双份冲突 ${result.conflicts.length} 条`
        : `基线 r${batch.baseRevision} 过期，后到一份未覆盖先到内容，可 rebase 后重试`
      if (result.outcome === 'merged') stored.conflictIds = result.conflicts.map((c) => deterministicConflictId(c.changeId))
    }
    save(next)
    server = next
    lastError.value = idempotentRetry ? `批次重试命中幂等记录（第 ${batch.attempts} 次），未重复写入` : ''
    hydrate(); announce()
  }

  /** CAS 拒绝后整批 rebase：以服务端当前修订号为新基线，再重试，不会覆盖先到内容 */
  function rebaseBatch(batchId: string) {
    const stored = server.batches.find((b) => b.id === batchId)
    if (!stored) return
    stored.changes = stored.changes.map((ch) => ({
      ...ch,
      base: stored.mode === 'online-cas'
        ? (server.targetRev[ch.targetId] ?? server.revision)
        : (server.fieldRev[`${ch.targetId}::${ch.field}`] ?? server.targetRev[ch.targetId] ?? server.revision),
    }))
    stored.baseRevision = server.revision
    stored.status = '待回传'
    stored.resultNote = `已 rebase 到 r${server.revision}：先到内容保留为本端基线，后到改动将作为新值提交`
    save(server)
    hydrate()
  }

  /** 冲突裁定：选定一份落库，另一份在审计记录中保留 */
  function resolveConflict(conflictId: string, keep: 'local' | 'remote') {
    const conflict = server.conflicts.find((c) => c.id === conflictId)
    if (!conflict || conflict.status !== '待裁定') return
    const nextScheme = structuredClone(server.scheme)
    const group = conflict.target === 'stage' ? nextScheme.stages : conflict.target === 'detour' ? nextScheme.detours : nextScheme.comments
    const target = group.find((item: { id: string }) => item.id === conflict.targetId) as Record<string, unknown> | undefined
    if (target) {
      if (keep === 'remote') {
        const sourceBatch = server.batches.find((b) => b.changes.some((ch) => ch.id === conflict.changeId))
        const change = sourceBatch?.changes.find((ch) => ch.id === conflict.changeId)
        if (change) target[conflict.field] = change.value
      }
      // keep === local：当前工作集即先入库值，无需改动
    }
    conflict.status = keep === 'local' ? '保留本地' : '保留回传'
    conflict.resolvedAt = now()
    let next = adminCommit(server, nextScheme, 'merge', `冲突 ${conflictId} 裁定：保留${keep === 'local' ? '先入库一份' : '后回传一份'}（${conflict.fieldLabel}），另一份留审计`)
    if (isInvalidatingField(conflict.target, conflict.field)) {
      next = invalidateIfNeeded(
        [{ target: conflict.target, targetId: conflict.targetId, field: conflict.field, unit: '建设' } as OfflineChange],
        next,
      )
    }
    server = next
    hydrate(); announce()
  }

  // ---------- 模拟两个窗口同提同一阶段 ----------
  function simulateConcurrentWindow() {
    const stageId = selectedStageId.value
    const stage = server.scheme.stages.find((s) => s.id === stageId)!
    const base = server.targetRev[stageId]

    // 1) 另一个窗口先到：改同一阶段的同一字段，直接 CAS 成功入库
    const remoteValue = `${stage.lanes}｜另一窗口改为 1 车道交替放行`
    const remoteChange: OfflineChange = {
      id: uid('CH'), target: 'stage', targetId: stageId, field: 'lanes', value: remoteValue,
      label: `${stageId} 车道收窄`, valueText: remoteValue, unit: '交通', base,
    }
    const remoteBatch: ChangeBatch = {
      id: uid('BX'), unit: '交通', source: '另一窗口（先到）', baseRevision: server.revision,
      mode: 'online-cas', status: '已合并', attempts: 1, createdAt: now(), submittedAt: now(),
      changes: [remoteChange], resultNote: '先到一份已入库', conflictIds: [],
    }
    const { state } = serverSubmit(server, remoteBatch)
    server = state

    if (online.value) {
      // 在线场景：再给本窗口准备一条基线陈旧的同字段提交，点提交即被 CAS 拒绝
      const myValue = `${stage.lanes}｜本窗口改为 3 车道保通`
      const myChange: OfflineChange = {
        id: uid('CH'), target: 'stage', targetId: stageId, field: 'lanes', value: myValue,
        label: `${stageId} 车道收窄`, valueText: myValue, unit: currentUnit.value, base,
      }
      const myBatch: ChangeBatch = {
        id: uid('BX'), unit: currentUnit.value, source: '本窗口（后到）', baseRevision: base,
        mode: 'online-cas', status: '待回传', attempts: 0, createdAt: now(),
        changes: [myChange],
        resultNote: '与另一窗口同改同一阶段，等待提交（预期被 CAS 拒绝）', conflictIds: [],
      }
      server = { ...server, batches: [myBatch, ...server.batches] }
      lastError.value = `并发场景已构造：另一窗口对 ${stageId} 的提交先到并已入库；请提交「本窗口（后到）」批次，验证后到一份不覆盖先到。`
    } else {
      lastError.value = `另一单位对 ${stageId} 的同字段改动已先入库；回传当前现场批次时，该字段将双份保留并标出冲突。`
    }
    save(server)
    hydrate(); announce()
  }

  // ---------- 冻结 / 失效 ----------
  function freeze(unit: Unit = currentUnit.value) {
    if (!canFreeze.value) return
    const snapshot: ApprovalSnapshot = {
      id: uid('AP'), frozenAt: now(), frozenBy: unit,
      schemeVersion: scheme.value.version, revision: server.revision + 1, valid: true,
      geometryByStage: Object.fromEntries(scheme.value.stages.map((s) => [s.id, geometryHash(s)])),
      conditionHash: conditionHash(scheme.value.comments),
      stages: structuredClone(scheme.value.stages.map((s) => ({ ...s, status: '已批准' as const }))),
      detours: structuredClone(scheme.value.detours),
      comments: structuredClone(scheme.value.comments),
    }
    server = serverFreeze(server, snapshot, unit)
    hydrate(); announce()
  }

  function setOnline(value: boolean) {
    online.value = value
    savePrefs()
    if (value) lastError.value = ''
  }
  function setUnit(unit: Unit) { currentUnit.value = unit; savePrefs() }
  /** 下一次批次提交注入故障（一次性）：transport 未到库 / lostAck 已落库但确认丢失 */
  function triggerFaultOnNextSubmit(fault: FaultMode) {
    faultMode.value = fault
    localStorage.setItem('yy54-road-fault', fault)
    savePrefs()
  }

  function undo() {
    const previous = history.value.pop()
    if (!previous) return
    const restored = JSON.parse(previous) as import('../types').Scheme
    server = adminCommit(server, restored, 'edit', '在线撤销上一处编辑，修订号整体推进')
    hydrate(); savePrefs(); announce()
  }

  function resetAll() {
    history.value = []
    const fresh = resetServer(seed.scheme)
    server = fresh
    savePrefs()
    hydrate(); announce()
  }

  function clearError() { lastError.value = '' }

  return {
    // state
    scheme, revision, conflicts, pendingConflicts, snapshots, activeSnapshot, invalidSnapshot,
    serverLogs, batches, staticConflicts,
    selectedStageId, selectedCommentId, selectedStage, selectedComment,
    drawing, draftRoute, online, currentUnit, faultMode, history, dirty, lastError,
    freezeGates, canFreeze,
    // stage derived
    stageStatus,
    // actions
    updateStage, updateDetour, startDraw, addPoint, finishDraw, resolveComment,
    reopenComment, reviseCommentCondition,
    submitBatch: submitBatchTransaction, rebaseBatch, discardBatch, resolveConflict,
    simulateConcurrentWindow, freeze, setOnline, setUnit, triggerFaultOnNextSubmit,
    undo, resetAll, clearError, hydrate,
  }
})
