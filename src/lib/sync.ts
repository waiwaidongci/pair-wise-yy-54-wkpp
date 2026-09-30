import type { ClosureStage, SegmentComment, Unit } from '../types'
import { cyrb53Exports } from './hash'

export function geometryHash(stage: Pick<ClosureStage, 'lanes' | 'route'>): string {
  return cyrb53Exports(JSON.stringify(stage))
}

/** 会签条件指纹：各分段已接受条件的内容与锚定几何 */
export function conditionHash(comments: SegmentComment[]): string {
  const accepted = comments
    .filter((item) => item.status === '已接受')
    .map((item) => [item.segmentId, item.unit, item.condition ?? '', item.anchoredHash ?? ''].join('|'))
    .sort()
  return cyrb53Exports(accepted.join('§'))
}

let counter = 0
export function uid(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export const FIELD_LABELS: Record<string, string> = {
  lanes: '车道收窄',
  name: '名称',
  start: '开始时间',
  end: '结束时间',
  route: '封路几何',
  extraMinutes: '绕行时延',
  distance: '绕行距离',
  coordinates: '绕行几何',
  condition: '会签条件',
  status: '会签结论',
}

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field
}

/** 几何 / 车道 / 绕行类字段：冻结后改动即令原审批失效 */
export function isInvalidatingField(target: string, field: string): boolean {
  if (target === 'stage') return ['lanes', 'route'].includes(field)
  if (target === 'detour') return true
  return false
}

export function valueText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `坐标 ${value.length} 点`
  return JSON.stringify(value ?? '')
}

export function unitColor(unit: Unit): string {
  return unit === '应急' ? 'red' : unit === '交通' ? 'blue' : unit === '公交' ? 'orange' : 'arcoblue'
}
