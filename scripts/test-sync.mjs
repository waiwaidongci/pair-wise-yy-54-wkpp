import { build } from 'esbuild'
import { writeFileSync, mkdirSync } from 'fs'

// 仅打包纯逻辑（mockServer 依赖 hash/sync/types，types 全是类型导入会被擦除）
const result = await build({
  entryPoints: ['src/lib/mockServer.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
mkdirSync('/tmp/rc-test', { recursive: true })
writeFileSync('/tmp/rc-test/server.mjs', result.outputFiles[0].text)
const mod = await import('/tmp/rc-test/server.mjs')

// localStorage shim
const storage = new Map()
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
}

const seed = {
  id: 'S1', project: 'P', version: 1,
  stages: [
    { id: 'ST-1', name: '阶段一', start: 'd1', end: 'd2', lanes: '4→2', status: '待协商', route: [[0, 0], [1, 1]] },
    { id: 'ST-2', name: '阶段二', start: 'd3', end: 'd4', lanes: '全封闭', status: '待协商', route: [[2, 2], [3, 3]] },
  ],
  detours: [{ id: 'D-1', name: '绕行甲', distance: 4, extraMinutes: 10, coordinates: [[0, 0]] }],
  comments: [],
}

let passed = 0; let failed = 0
function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✕ ${name} ${extra}`) }
}
function change(partial) {
  return { id: partial.id, target: partial.target, targetId: partial.targetId, field: partial.field, value: partial.value, label: partial.label, valueText: partial.valueText, unit: partial.unit, base: partial.base }
}
function batch(partial) {
  return {
    id: partial.id, unit: partial.unit ?? '建设', source: partial.source ?? 'test',
    baseRevision: partial.baseRevision, mode: partial.mode, status: '提交中', attempts: partial.attempts ?? 1,
    createdAt: 't', changes: partial.changes, conflictIds: [],
  }
}

console.log('\n[1] 离线批次合并：同阶段两边都改 → 双份冲突；未动的字段快进合并')
{
  let server = mod.resetServer(seed)
  const base = server.revision
  // 服务端（另一单位）先把 ST-1.lanes 改成 A
  let r = mod.submitBatch(server, batch({
    id: 'B-remote', unit: '交通', baseRevision: base, mode: 'online-cas',
    changes: [change({ id: 'C-r', target: 'stage', targetId: 'ST-1', field: 'lanes', value: 'A', valueText: 'A', label: 'lanes', unit: '交通', base: server.targetRev['ST-1'] })],
  }))
  server = r.state
  assert('另一单位先到提交成功', r.result.outcome === 'merged')
  // 本单位离线批次基线是旧值：ST-1.lanes 改成 B（冲突），ST-1.name 改成 N（未被动过→快进）
  r = mod.submitBatch(server, batch({
    id: 'B-local', unit: '建设', baseRevision: base, mode: 'offline-merge',
    changes: [
      change({ id: 'C-l1', target: 'stage', targetId: 'ST-1', field: 'lanes', value: 'B', valueText: 'B', label: 'lanes', unit: '建设', base: 7 }),
      change({ id: 'C-l2', target: 'stage', targetId: 'ST-1', field: 'name', value: 'N', valueText: 'N', label: 'name', unit: '建设', base: 7 }),
    ],
  }))
  server = r.state
  assert('离线批次整体仍 merged（非整批拒绝）', r.result.outcome === 'merged')
  assert('车道字段产生 1 条双份冲突', r.result.conflicts.length === 1 && r.result.conflicts[0].localText === 'A' && r.result.conflicts[0].remoteText === 'B')
  assert('先到的 A 保留在服务端，未被 B 覆盖', server.scheme.stages[0].lanes === 'A')
  assert('无冲突的 name 快进合并为 N', server.scheme.stages[0].name === 'N')
}

console.log('\n[2] 两个窗口同提一阶段（online-cas）：后到整批拒绝，不写任何内容')
{
  let server = mod.resetServer(seed)
  const base = server.revision
  let r = mod.submitBatch(server, batch({
    id: 'W1', unit: '交通', baseRevision: base, mode: 'online-cas',
    changes: [change({ id: 'W1c', target: 'stage', targetId: 'ST-2', field: 'lanes', value: 'WIN1', valueText: 'WIN1', label: 'lanes', unit: '交通', base: server.targetRev['ST-2'] })],
  }))
  server = r.state
  const r2 = mod.submitBatch(server, batch({
    id: 'W2', unit: '建设', baseRevision: base, mode: 'online-cas',
    changes: [
      change({ id: 'W2a', target: 'stage', targetId: 'ST-2', field: 'lanes', value: 'WIN2', valueText: 'WIN2', label: 'lanes', unit: '建设', base }),
      change({ id: 'W2b', target: 'stage', targetId: 'ST-2', field: 'name', value: 'NAME2', valueText: 'NAME2', label: 'name', unit: '建设', base }),
    ],
  }))
  server = r2.state
  assert('后到批次 outcome=stale', r2.result.outcome === 'stale')
  assert('先到值 WIN1 未被覆盖', server.scheme.stages[1].lanes === 'WIN1')
  assert('同批次的 name 也未写入（原子性）', server.scheme.stages[1].name === '阶段二')
  assert('staleTargets 给出服务端当前值', r2.result.staleTargets[0].serverText === 'WIN1')
}

console.log('\n[3] 失败后整批重试：transport 不写入；lostAck 重试幂等不重复')
{
  let server = mod.resetServer(seed)
  const base = server.revision
  // 3a transport：下一次调用抛错，服务端无批次结果
  mod.armFault('transport')
  let threw = false
  try {
    mod.submitBatch(server, batch({
      id: 'F1', baseRevision: base, mode: 'offline-merge',
      changes: [change({ id: 'F1c', target: 'stage', targetId: 'ST-1', field: 'name', value: 'X', valueText: 'X', label: 'name', unit: '建设', base: 7 })],
    }))
  } catch { threw = true }
  server = mod.loadServer()
  assert('transport 抛错', threw)
  assert('transport 时无结果记录', !server.batchResults['F1'])
  assert('transport 时 name 未写入', server.scheme.stages[0].name === '阶段一')
  // 3b 重试成功
  const rr = mod.submitBatch(server, batch({
    id: 'F1', attempts: 2, baseRevision: base, mode: 'offline-merge',
    changes: [change({ id: 'F1c', target: 'stage', targetId: 'ST-1', field: 'name', value: 'X', valueText: 'X', label: 'name', unit: '建设', base: 7 })],
  }))
  server = rr.state
  assert('整批重试成功', rr.result.outcome === 'merged' && server.scheme.stages[0].name === 'X')
  assert('改动只写入一次（appliedIds 唯一）', new Set(server.appliedIds).size === server.appliedIds.length)
  // 3c 再次重试 → 幂等回放
  const rr2 = mod.submitBatch(server, batch({
    id: 'F1', attempts: 3, baseRevision: base, mode: 'offline-merge',
    changes: [change({ id: 'F1c', target: 'stage', targetId: 'ST-1', field: 'name', value: 'X', valueText: 'X', label: 'name', unit: '建设', base: 7 })],
  }))
  server = rr2.state
  assert('重复批次命中幂等记录', rr2.idempotentRetry === true)
  assert('幂等回放后 name 仍为 X，无重复写入', server.scheme.stages[0].name === 'X')
}

console.log('\n[4] lostAck：已落库但确认丢失，重试不重复写入')
{
  let server = mod.resetServer(seed)
  const base = server.revision
  mod.armFault('lostAck')
  let threw = false
  try {
    mod.submitBatch(server, batch({
      id: 'L1', baseRevision: base, mode: 'offline-merge',
      changes: [change({ id: 'L1c', target: 'stage', targetId: 'ST-2', field: 'name', value: 'Y', valueText: 'Y', label: 'name', unit: '应急', base: 7 })],
    }))
  } catch { threw = true }
  server = mod.loadServer()
  assert('lostAck 对客户端抛错', threw)
  assert('但服务端已落库 name=Y', server.scheme.stages[1].name === 'Y')
  assert('服务端已有批次结果', !!server.batchResults['L1'])
  const retry = mod.submitBatch(server, batch({
    id: 'L1', attempts: 2, baseRevision: base, mode: 'offline-merge',
    changes: [change({ id: 'L1c', target: 'stage', targetId: 'ST-2', field: 'name', value: 'Y', valueText: 'Y', label: 'name', unit: '应急', base })],
  }))
  assert('重试返回 idempotentRetry', retry.idempotentRetry === true)
  assert('重试不新增改动记录', retry.state.appliedIds.filter((x) => x === 'L1c').length === 1)
}

console.log('\n[5] 快照冻结后：车道/绕行/应急一变立即失效；同批次内多改动不误判冲突')
{
  let server = mod.resetServer(seed)
  const snap = {
    id: 'AP-1', frozenAt: 't', frozenBy: '建设', schemeVersion: 1, revision: server.revision + 1, valid: true,
    geometryByStage: { 'ST-1': 'h1', 'ST-2': 'h2' }, conditionHash: 'c1',
    stages: seed.stages.map((s) => ({ ...s, status: '已批准' })), detours: seed.detours, comments: [],
  }
  server = mod.freezeSnapshot(server, snap, '建设')
  assert('冻结后存在生效快照', server.snapshots[0].valid === true)
  // 同批次内对 ST-1 的连续两条编辑（模拟两条 applyChange 入同一现场批）
  const base = server.revision
  const r = mod.submitBatch(server, batch({
    id: 'E1', baseRevision: base, mode: 'offline-merge',
    changes: [
      change({ id: 'E1a', target: 'stage', targetId: 'ST-1', field: 'lanes', value: 'Z1', valueText: 'Z1', label: 'lanes', unit: '建设', base: server.fieldRev['ST-1::lanes'] }),
      change({ id: 'E1b', target: 'stage', targetId: 'ST-1', field: 'name', value: 'Z2', valueText: 'Z2', label: 'name', unit: '建设', base: 7 }),
    ],
  }))
  assert('同批次同对象连续改动不产生伪冲突', r.result.conflicts.length === 0)
  server = mod.invalidateSnapshot(r.state, '阶段 ST-1 的车道收窄被建设单位修改', ['ST-1'])
  assert('车道一变，快照立即失效', server.snapshots[0].valid === false)
  assert('失效原因被记录', server.snapshots[0].invalidReason.includes('车道'))
  // 绕行变化同样失效（新快照 → 绕行改）
  let s2 = mod.freezeSnapshot(server, { ...snap, id: 'AP-2', revision: server.revision + 1 }, '交通')
  const base2 = s2.revision
  const r2 = mod.submitBatch(s2, batch({
    id: 'E2', baseRevision: base2, mode: 'online-cas',
    changes: [change({ id: 'E2c', target: 'detour', targetId: 'D-1', field: 'extraMinutes', value: 22, valueText: '22', label: 'detour', unit: '交通', base: s2.targetRev['D-1'] })],
  }))
  s2 = r2.state
  s2 = mod.invalidateSnapshot(s2, '绕行方案 D-1 被交通单位修改', ['ST-1', 'ST-2'])
  assert('绕行一变，新快照也立即失效', s2.snapshots.find((s) => s.id === 'AP-2').valid === false)
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
