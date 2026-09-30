import type {
  ApprovalSnapshot, ChangeBatch, FaultMode, MergeConflict, OfflineChange, Scheme, ServerLogEntry, Unit,
} from '../types'
import { cyrb53Exports } from './hash'
import { valueText } from './sync'

const SERVER_KEY = 'yy54-road-server-v2'
const FAULT_KEY = 'yy54-road-fault'

export interface RawConflict {
  changeId: string
  batchId: string
  stageId: string
  target: OfflineChange['target']
  targetId: string
  field: string
  localText: string
  remoteText: string
}

export interface BatchResult {
  outcome: 'merged' | 'stale'
  at: string
  revisionAfter: number
  appliedIds: string[]
  conflicts: RawConflict[]
  staleTargets?: { targetId: string; field: string; baseRevision: number; serverRevision: number; serverText: string }[]
}

export interface ServerState {
  scheme: Scheme
  revision: number
  /** 对象（阶段 / 绕行 / 意见）最后改动修订号 —— online-cas 按对象做乐观锁 */
  targetRev: Record<string, number>
  /** 字段最后改动修订号 —— offline-merge 按字段判断两边是否同改 */
  fieldRev: Record<string, number>
  appliedIds: string[]
  batchResults: Record<string, BatchResult>
  batches: ChangeBatch[]
  conflicts: MergeConflict[]
  snapshots: ApprovalSnapshot[]
  logs: ServerLogEntry[]
}

export class TransportFailure extends Error {
  constructor(public kind: FaultMode) {
    super(kind === 'lostAck' ? '服务器已提交但确认丢失' : '弱网：提交未到达服务器')
  }
}

export function deterministicConflictId(changeId: string): string {
  return `CF-${cyrb53Exports(changeId)}`.slice(0, 16)
}

function now(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function addLog(state: ServerState, kind: ServerLogEntry['kind'], text: string) {
  state.logs.unshift({ id: `LG-${state.logs.length + 1}-${Date.now().toString(36)}`, time: now(), kind, text })
  state.logs = state.logs.slice(0, 60)
}

function fkey(ch: Pick<OfflineChange, 'targetId' | 'field'>): string {
  return `${ch.targetId}::${ch.field}`
}

export function initServer(seed: Scheme): ServerState {
  const raw = localStorage.getItem(SERVER_KEY)
  if (raw) return JSON.parse(raw) as ServerState
  const targetRev: Record<string, number> = {}
  const fieldRev: Record<string, number> = {}
  const stamp = (id: string, fields: string[]) => fields.forEach((f) => { targetRev[id] = 7; fieldRev[`${id}::${f}`] = 7 })
  seed.stages.forEach((s) => stamp(s.id, ['name', 'start', 'end', 'lanes', 'status', 'route']))
  seed.detours.forEach((d) => stamp(d.id, ['name', 'distance', 'extraMinutes', 'coordinates']))
  seed.comments.forEach((c) => stamp(c.id, ['condition', 'status', 'anchoredHash']))
  const state: ServerState = {
    scheme: structuredClone(seed), revision: 7, targetRev, fieldRev,
    appliedIds: [], batchResults: {}, batches: [], conflicts: [], snapshots: [], logs: [],
  }
  addLog(state, 'edit', '权威数据初始化：3 个阶段、2 条绕行、3 条会签意见（修订号 r7）')
  save(state)
  return state
}

export function loadServer(): ServerState | null {
  const raw = localStorage.getItem(SERVER_KEY)
  return raw ? JSON.parse(raw) as ServerState : null
}

export function save(state: ServerState) {
  localStorage.setItem(SERVER_KEY, JSON.stringify(state))
}

export function consumeFault(): FaultMode {
  const fault = (localStorage.getItem(FAULT_KEY) as FaultMode | null) ?? 'none'
  localStorage.removeItem(FAULT_KEY)
  return fault
}

export function armFault(fault: FaultMode) {
  localStorage.setItem(FAULT_KEY, fault)
}

function locate(scheme: Scheme, ch: OfflineChange): { value: unknown; stageId: string } {
  if (ch.target === 'stage') {
    const stage = scheme.stages.find((s) => s.id === ch.targetId)!
    return { value: stage[ch.field as keyof typeof stage], stageId: stage.id }
  }
  if (ch.target === 'detour') {
    const detour = scheme.detours.find((d) => d.id === ch.targetId)!
    return { value: detour[ch.field as keyof typeof detour], stageId: '' }
  }
  const comment = scheme.comments.find((c) => c.id === ch.targetId)!
  return { value: comment[ch.field as keyof typeof comment], stageId: comment.segmentId }
}

function writeTarget(scheme: Scheme, ch: OfflineChange) {
  const group = ch.target === 'stage' ? scheme.stages : ch.target === 'detour' ? scheme.detours : scheme.comments
  const target = group.find((item: { id: string }) => item.id === ch.targetId)! as unknown as Record<string, unknown>
  target[ch.field] = ch.value
}

export interface SubmitOutcome {
  result: BatchResult
  state: ServerState
  idempotentRetry: boolean
}

function applyOne(state: ServerState, ch: OfflineChange, appliedIds: string[]) {
  writeTarget(state.scheme, ch)
  state.revision += 1
  state.targetRev[ch.targetId] = state.revision
  state.fieldRev[fkey(ch)] = state.revision
  state.appliedIds.push(ch.id)
  appliedIds.push(ch.id)
}

/**
 * 原子提交：副本上完成全部校验与改动后一次落库。
 * - online-cas：对象级乐观锁。同一对象基线之后被任何窗口动过 → 整批拒绝，不写任何内容。
 * - offline-merge：字段级三方合并。仅当同一字段两边都改过时双份保留标冲突；
 *   同对象的其他字段、以及同批次内对同字段的后续改动正常快进。
 * - 重复批次 / 重复改动：回放首次结果，不重复写入。
 */
export function submitBatch(prev: ServerState, batch: ChangeBatch): SubmitOutcome {
  const recorded = prev.batchResults[batch.id]
  if (recorded) {
    const state = structuredClone(prev)
    addLog(state, 'idempotent', `批次 ${batch.id} 重试命中幂等记录，回放 ${recorded.outcome === 'merged' ? '合并' : '拒绝'} 结果，未重复写入`)
    save(state)
    return { result: recorded, state, idempotentRetry: true }
  }

  const fault = consumeFault()
  if (fault === 'transport') throw new TransportFailure('transport')

  const state = structuredClone(prev)
  const appliedIds: string[] = []
  const conflicts: RawConflict[] = []

  if (batch.mode === 'online-cas') {
    // 对象级 CAS：每个改动携带提交时刻的对象修订号（rebase 时刷新）
    const seenTargets = new Set<string>()
    const staleTargets: NonNullable<BatchResult['staleTargets']> = []
    batch.changes.forEach((ch) => {
      const base = ch.base ?? batch.baseRevision
      const serverRev = state.targetRev[ch.targetId]
      if (!seenTargets.has(ch.targetId) && serverRev !== base) {
        staleTargets.push({ targetId: ch.targetId, field: ch.field, baseRevision: base, serverRevision: serverRev, serverText: valueText(locate(state.scheme, ch).value) })
        seenTargets.add(ch.targetId)
      }
    })
    if (staleTargets.length > 0) {
      const result: BatchResult = { outcome: 'stale', at: now(), revisionAfter: state.revision, appliedIds: [], conflicts: [], staleTargets }
      state.batchResults[batch.id] = result
      addLog(state, 'cas', `并发保护：${batch.unit}窗口批次 ${batch.id} 基线 r${batch.baseRevision} 过期，后到一份未覆盖先到内容（${staleTargets.map((s) => s.targetId).join('、')}）`)
      if (fault === 'lostAck') { save(state); throw new TransportFailure('lostAck') }
      save(state)
      return { result, state, idempotentRetry: false }
    }
    batch.changes.forEach((ch) => { applyOne(state, ch, appliedIds); seenTargets.add(ch.targetId) })
    addLog(state, 'cas', `${batch.unit}窗口 CAS 提交成功（基线 r${batch.baseRevision}）：${batch.changes.map((c) => c.label).join('、')}`)
  } else {
    // 字段级离线合并
    const fieldsWrittenInBatch = new Set<string>()
    batch.changes.forEach((ch) => {
      const fieldKey = fkey(ch)
      const base = ch.base ?? batch.baseRevision
      const fieldServerRev = state.fieldRev[fieldKey]
      // 同批次已写过该字段（同对象连续编辑）→ 接着写
      if (fieldsWrittenInBatch.has(fieldKey)) {
        applyOne(state, ch, appliedIds)
        return
      }
      // 字段基线之后没人动过（或整对象都没动过）→ 快进合并
      if (fieldServerRev === base || (state.targetRev[ch.targetId] === base && fieldServerRev === undefined)) {
        applyOne(state, ch, appliedIds)
        fieldsWrittenInBatch.add(fieldKey)
        return
      }
      // 两边都动了这个字段
      const { value, stageId } = locate(state.scheme, ch)
      const serverText = valueText(value)
      if (serverText === ch.valueText) {
        addLog(state, 'merge', `改动 ${ch.label} 与已入库内容一致，自动消解，不重复写入`)
        state.appliedIds.push(ch.id)
        fieldsWrittenInBatch.add(fieldKey)
        return
      }
      conflicts.push({ changeId: ch.id, batchId: batch.id, stageId, target: ch.target, targetId: ch.targetId, field: ch.field, localText: serverText, remoteText: ch.valueText })
      fieldsWrittenInBatch.add(fieldKey)
    })
    addLog(state, 'merge', `${batch.unit}现场批次 ${batch.id} 回传合并：应用 ${appliedIds.length} 条，冲突双份保留 ${conflicts.length} 条`)
  }

  const result: BatchResult = { outcome: 'merged', at: now(), revisionAfter: state.revision, appliedIds, conflicts }
  state.batchResults[batch.id] = result
  if (fault === 'lostAck') { save(state); throw new TransportFailure('lostAck') }
  save(state)
  return { result, state, idempotentRetry: false }
}

/** 管理端直接落库（冲突裁定、撤销）：整体推进修订号并令旧基线全部过期 */
export function adminCommit(prev: ServerState, scheme: Scheme, kind: ServerLogEntry['kind'], text: string): ServerState {
  const state = structuredClone(prev)
  state.scheme = scheme
  state.revision += 1
  Object.keys(state.targetRev).forEach((id) => {
    state.targetRev[id] = state.revision
    Object.keys(state.fieldRev).filter((k) => k.startsWith(`${id}::`)).forEach((k) => { state.fieldRev[k] = state.revision })
  })
  addLog(state, kind, text)
  save(state)
  return state
}

export function freezeSnapshot(prev: ServerState, snapshot: ApprovalSnapshot, unit: Unit): ServerState {
  const state = structuredClone(prev)
  state.snapshots.push(snapshot)
  state.revision += 1
  addLog(state, 'freeze', `${unit}冻结审批快照 ${snapshot.id}（几何 ${Object.keys(snapshot.geometryByStage).length} 段，修订号 r${state.revision}）：地图、总览、公开通告统一按此快照判断`)
  save(state)
  return state
}

export function invalidateSnapshot(prev: ServerState, reason: string, scope: string[]): ServerState {
  const state = structuredClone(prev)
  const snap = state.snapshots.filter((s) => s.valid).at(-1)
  if (!snap) return prev
  snap.valid = false
  snap.invalidAt = now()
  snap.invalidReason = reason
  state.revision += 1
  scope.forEach((id) => {
    state.targetRev[id] = state.revision
    Object.keys(state.fieldRev).filter((k) => k.startsWith(`${id}::`)).forEach((k) => { state.fieldRev[k] = state.revision })
  })
  addLog(state, 'invalidate', `审批快照 ${snap.id} 立即失效：${reason}；原批准状态回退，需重新冻结`)
  save(state)
  return state
}

export function resetServer(seed: Scheme): ServerState {
  localStorage.removeItem(SERVER_KEY)
  return initServer(seed)
}
