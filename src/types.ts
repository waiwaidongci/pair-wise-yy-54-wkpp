export type StageStatus = '待协商' | '条件通过' | '已批准' | '退回' | '冲突待裁'
export type Unit = '建设' | '交通' | '公交' | '应急'

export interface ClosureStage {
  id: string
  name: string
  start: string
  end: string
  lanes: string
  status: StageStatus
  route: [number, number][]
}

export interface DetourRoute {
  id: string
  name: string
  distance: number
  extraMinutes: number
  coordinates: [number, number][]
}

export interface SegmentComment {
  id: string
  segmentId: string
  unit: Unit
  author: string
  content: string
  condition?: string
  status: '待处理' | '已接受' | '已退回'
  /** 接受条件时锚定的阶段几何哈希；几何再变即与当前不一致 */
  anchoredHash?: string
}

export interface Scheme {
  id: string
  project: string
  contractor: string
  area: string
  version: number
  stages: ClosureStage[]
  detours: DetourRoute[]
  comments: SegmentComment[]
}

/** 离线期间各单位产生的单条改动（幂等键 = id） */
export interface OfflineChange {
  id: string
  target: 'stage' | 'detour' | 'comment'
  targetId: string
  field: string
  value: unknown
  label: string
  valueText: string
  unit: Unit
  /** rebase 后按对象记录的 CAS 基线；缺省取批次 baseRevision */
  base?: number
}

export type BatchMode = 'offline-merge' | 'online-cas'
export type BatchStatus = '待回传' | '提交中' | '已合并' | '已拒绝' | '失败待重试' | '幂等命中'

/** 现场批次：同一批次原子提交，失败整批重试 */
export interface ChangeBatch {
  id: string
  unit: Unit
  source: string
  baseRevision: number
  mode: BatchMode
  status: BatchStatus
  attempts: number
  createdAt: string
  submittedAt?: string
  changes: OfflineChange[]
  resultNote?: string
  conflictIds: string[]
}

export type MergeConflictStatus = '待裁定' | '保留本地' | '保留回传'

/** 同一阶段两边都改过：两份内容都保留，标出冲突等待裁定 */
export interface MergeConflict {
  id: string
  changeId: string
  batchId: string
  stageId: string
  target: OfflineChange['target']
  targetId: string
  field: string
  fieldLabel: string
  localLabel: string
  remoteLabel: string
  localText: string
  remoteText: string
  status: MergeConflictStatus
  createdAt: string
  resolvedAt?: string
}

/** 冻结的审批快照：地图、总览、公开通告都按它判断 */
export interface ApprovalSnapshot {
  id: string
  frozenAt: string
  frozenBy: Unit
  schemeVersion: number
  revision: number
  valid: boolean
  invalidAt?: string
  invalidReason?: string
  geometryByStage: Record<string, string>
  conditionHash: string
  stages: ClosureStage[]
  detours: DetourRoute[]
  comments: SegmentComment[]
}

export interface ServerLogEntry {
  id: string
  time: string
  kind: 'edit' | 'merge' | 'cas' | 'retry' | 'freeze' | 'invalidate' | 'idempotent'
  text: string
}

export type FaultMode = 'none' | 'transport' | 'lostAck'

export interface SnapshotGate {
  key: string
  label: string
  passed: boolean
  hint: string
}
