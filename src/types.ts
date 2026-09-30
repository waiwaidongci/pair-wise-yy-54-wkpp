export type StageStatus = '待协商' | '条件通过' | '已批准' | '退回'

export type Unit = '建设' | '交通' | '公交' | '应急'

export interface ClosureStage {
  id: string
  name: string
  start: string
  end: string
  lanes: string
  status: StageStatus
  route: [number, number][]
  /** 乐观并发版本号：每次提交自增，后到的提交不得覆盖先到内容 */
  version: number
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

/** 离线改动：按现场批次回传的单条阶段修改 */
export interface StageChange {
  stageId: string
  /** 提交方基于的版本号，用于乐观并发校验 */
  baseVersion: number
  patch: Partial<ClosureStage>
  timestamp: string
}

/** 离线批次：各单位离线改动回传后按现场批次合并 */
export interface OfflineBatch {
  id: string
  unit: Unit
  changes: StageChange[]
  createdAt: string
  status: 'pending' | 'applying' | 'applied' | 'failed'
  /** 幂等键：失败后整批重试不重复写入 */
  idempotencyKey: string
  error?: string
}

/** 阶段冲突：同一阶段两边都改过，保留两份并标出 */
export interface StageConflict {
  id: string
  stageId: string
  batchId: string
  detectedAt: string
  local: ClosureStage
  remote: ClosureStage
  resolved: boolean
}

/** 审批快照：几何与会签条件一致时冻结，地图/总览/通告均以此为准 */
export interface ApprovalSnapshot {
  id: string
  frozenAt: string
  schemeVersion: number
  geometryHash: string
  conditionsHash: string
  stages: ClosureStage[]
  detours: DetourRoute[]
  status: 'frozen' | 'invalidated'
  invalidatedReason?: string
}
