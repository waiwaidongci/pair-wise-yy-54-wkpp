<script setup lang="ts">
import { computed } from 'vue'
import { useSchemeStore } from '../store/scheme'
import type { FaultMode } from '../types'

const store = useSchemeStore()

const pendingBatches = computed(() => store.batches.filter((b) => b.status !== '已合并'))
const recentMerged = computed(() => store.batches.filter((b) => b.status === '已合并').slice(0, 4))

const batchTag: Record<string, { color: string; text: string }> = {
  待回传: { color: 'orange', text: '待回传' },
  提交中: { color: 'blue', text: '提交中' },
  已合并: { color: 'green', text: '已合并' },
  已拒绝: { color: 'red', text: 'CAS 拒绝' },
  失败待重试: { color: 'red', text: '失败待重试' },
  幂等命中: { color: 'purple', text: '幂等命中' },
}

const faults: { value: FaultMode; label: string; hint: string }[] = [
  { value: 'none', label: '链路正常', hint: '提交即达' },
  { value: 'transport', label: '弱网中断（未到库）', hint: '整批失败，重试可成功' },
  { value: 'lostAck', label: '确认丢失（已到库）', hint: '重试命中幂等，不重复写入' },
]

function armFault(value: FaultMode) {
  store.triggerFaultOnNextSubmit(value)
}

const gateColor = computed(() => store.freezeGates.every((g) => g.passed) ? 'green' : 'red')
</script>

<template>
  <section class="page-head compact">
    <div>
      <p class="eyebrow">现场批次 · 并发保护 · 审批快照</p>
      <h1>离线回传与冻结审批</h1>
      <p>离线改动按现场批次原子提交：同一阶段两边都改则双份保留标冲突；两个窗口同提一阶段，后到不覆盖先到；失败整批重试且幂等不重复写入。</p>
    </div>
    <a-space>
      <a-button @click="store.resetAll">重置演示数据</a-button>
      <a-button type="primary" :disabled="!store.canFreeze" @click="store.freeze()">冻结审批快照</a-button>
    </a-space>
  </section>

  <a-alert v-if="store.lastError" :title="store.lastError" type="warning" closable class="mb16" @close="store.clearError()" />

  <div class="sync-grid">
    <!-- 左：连接 / 单位 / 故障 -->
    <div class="col">
      <article class="card">
        <div class="panel-head"><h2>现场连接</h2><a-tag :color="store.online ? 'green' : 'orange'">{{ store.online ? '在线' : '离线' }}</a-tag></div>
        <a-switch :model-value="store.online" checked-text="在线协同" unchecked-text="离线作业" @change="(v: string | number | boolean) => store.setOnline(Boolean(v))" />
        <p class="hint">{{ store.online ? '编辑立即走单条 CAS 事务提交；另一窗口先改同一对象时本端被拒绝。' : '地图 / 阶段 / 会签的编辑全部进入下方现场批次，恢复连接后按批回传合并。' }}</p>
        <a-divider />
        <h3>当前会签单位</h3>
        <a-radio-group :model-value="store.currentUnit" type="button" direction="vertical" class="unit-radio" @change="(v: string | number | boolean) => store.setUnit(v as any)">
          <a-radio value="建设">建设单位</a-radio>
          <a-radio value="交通">交通单位</a-radio>
          <a-radio value="公交">公交单位</a-radio>
          <a-radio value="应急">应急单位</a-radio>
        </a-radio-group>
      </article>

      <article class="card">
        <div class="panel-head"><h2>故障注入（一次性）</h2><a-tag>服务端修订号 r{{ store.revision }}</a-tag></div>
        <p class="hint">对下一次批次提交生效，用于演示「失败后整批重试且不重复写入」。</p>
        <button v-for="fault in faults" :key="fault.value" class="fault" :class="{ active: store.faultMode === fault.value }" @click="armFault(fault.value)">
          <b>{{ fault.label }}</b><small>{{ fault.hint }}</small>
        </button>
        <a-divider />
        <h3>并发演示</h3>
        <p class="hint">模拟第二个窗口在当前阶段上先提交一次车道修改：随后你在地图上再改同一阶段会被 CAS 拒绝（后到不覆盖先到）。</p>
        <a-button long status="warning" @click="store.simulateConcurrentWindow()">模拟另一窗口先提交「{{ store.selectedStageId }}」</a-button>
      </article>
    </div>

    <!-- 中：批次 -->
    <div class="col">
      <article class="card">
        <div class="panel-head"><div><h2>现场批次</h2><p>原子提交 · 基线修订号 r{{ store.revision }}</p></div><a-tag color="orange">{{ pendingBatches.length }} 个在途</a-tag></div>
        <div v-if="pendingBatches.length === 0" class="empty">没有待回传 / 待重试批次。切到「离线」后到地图或会签页编辑，改动会自动入批。</div>
        <div v-for="batch in pendingBatches" :key="batch.id" class="batch" :class="{ rejected: batch.status === '已拒绝', failed: batch.status === '失败待重试' }">
          <div class="batch-head">
            <div><b>{{ batch.unit }} · {{ batch.source }}</b><small>{{ batch.id }} · 基线 r{{ batch.baseRevision }} · 尝试 {{ batch.attempts }} 次 · {{ batch.createdAt }}</small></div>
            <a-tag :color="batchTag[batch.status]?.color">{{ batch.status }}</a-tag>
          </div>
          <ul class="changes">
            <li v-for="ch in batch.changes" :key="ch.id"><span>{{ ch.label }}</span><em>{{ ch.valueText }}</em></li>
          </ul>
          <small v-if="batch.resultNote" class="note">{{ batch.resultNote }}</small>
          <div class="batch-actions">
            <a-button size="small" @click="store.discardBatch(batch.id)">丢弃整批</a-button>
            <a-button v-if="batch.status === '已拒绝'" size="small" @click="store.rebaseBatch(batch.id)">Rebase 到 r{{ store.revision }}</a-button>
            <a-button size="small" type="primary" :loading="batch.status === '提交中'" @click="store.submitBatch(batch.id)">
              {{ batch.status === '失败待重试' || batch.status === '已拒绝' ? '整批重试' : batch.mode === 'offline-merge' ? '回传合并' : '提交' }}
            </a-button>
          </div>
        </div>
      </article>

      <article class="card">
        <div class="panel-head"><h2>最近提交记录</h2></div>
        <div v-for="batch in recentMerged" :key="batch.id" class="logline">
          <a-tag :color="batchTag[batch.status]?.color" size="small">{{ batch.status }}</a-tag>
          <span>{{ batch.unit }} · {{ batch.source }} · {{ batch.id }}</span>
          <small>{{ batch.resultNote }}</small>
        </div>
        <div v-if="recentMerged.length === 0" class="empty">尚无已合并批次。</div>
      </article>
    </div>

    <!-- 右：冲突 + 快照 -->
    <div class="col">
      <article class="card">
        <div class="panel-head"><div><h2>合并冲突（双份保留）</h2><p>同一阶段两边都改过：两份都留，裁定前阶段显示「冲突待裁」</p></div><a-tag color="red">{{ store.pendingConflicts.length }} 待裁定</a-tag></div>
        <div v-for="conflict in store.conflicts" :key="conflict.id" class="conflict-card" :class="{ done: conflict.status !== '待裁定' }">
          <div class="conflict-head"><b>{{ conflict.stageId }} · {{ conflict.fieldLabel }}</b><a-tag :color="conflict.status === '待裁定' ? 'red' : 'gray'">{{ conflict.status }}</a-tag></div>
          <div class="two-sides">
            <div class="side local"><span>{{ conflict.localLabel }}</span><p>{{ conflict.localText }}</p></div>
            <div class="side remote"><span>{{ conflict.remoteLabel }}</span><p>{{ conflict.remoteText }}</p></div>
          </div>
          <div v-if="conflict.status === '待裁定'" class="conflict-actions">
            <a-button size="small" @click="store.resolveConflict(conflict.id, 'local')">保留先入库</a-button>
            <a-button size="small" type="primary" @click="store.resolveConflict(conflict.id, 'remote')">保留后回传</a-button>
          </div>
          <small v-else class="note">裁定于 {{ conflict.resolvedAt }}，另一份保留在审计记录</small>
        </div>
        <div v-if="store.conflicts.length === 0" class="empty">暂无合并冲突。</div>
      </article>

      <article class="card">
        <div class="panel-head"><h2>冻结闸门</h2><a-tag :color="gateColor">{{ store.canFreeze ? '当前几何 = 会签条件' : '不一致，禁止冻结' }}</a-tag></div>
        <div v-for="gate in store.freezeGates" :key="gate.key" class="gate" :class="gate.passed ? 'pass' : 'fail'">
          <span>{{ gate.passed ? '✓' : '✕' }}</span>
          <div><b>{{ gate.label }}</b><small>{{ gate.hint }}</small></div>
        </div>
        <a-button long type="primary" :disabled="!store.canFreeze" class="mt10" @click="store.freeze()">四项一致，冻结审批快照</a-button>
      </article>

      <article v-if="store.activeSnapshot || store.invalidSnapshot" class="card" :class="{ snapshotInvalid: store.invalidSnapshot }">
        <div class="panel-head"><h2>当前审批快照</h2><a-tag :color="store.activeSnapshot ? 'green' : 'red'">{{ store.activeSnapshot ? '生效中' : '已失效' }}</a-tag></div>
        <template v-if="store.activeSnapshot">
          <p class="snap">{{ store.activeSnapshot.id }} · 修订号 r{{ store.activeSnapshot.revision }}</p>
          <small>冻结于 {{ store.activeSnapshot.frozenAt }}（{{ store.activeSnapshot.frozenBy }}），地图、总览、公开通告统一按此快照判断。</small>
          <a-alert type="info" class="mt10" title="冻结后一旦车道、绕行或应急条件变化，该审批立即失效，阶段「已批准」自动回退。" />
        </template>
        <template v-else-if="store.invalidSnapshot">
          <p class="snap">{{ store.invalidSnapshot.id }} · 原修订号 r{{ store.invalidSnapshot.revision }}</p>
          <a-alert type="error" :title="`原审批已于 ${store.invalidSnapshot.invalidAt} 失效：${store.invalidSnapshot.invalidReason}`" />
          <small class="note">请重新核对几何与会签条件后再次冻结。</small>
        </template>
      </article>
    </div>
  </div>

  <article class="card mt16">
    <div class="panel-head"><h2>服务端事务日志</h2><a-tag>{{ store.serverLogs.length }} 条</a-tag></div>
    <div class="server-log">
      <div v-for="log in store.serverLogs" :key="log.id" class="logline">
        <a-tag size="small" :color="log.kind === 'cas' ? 'orange' : log.kind === 'merge' ? 'blue' : log.kind === 'invalidate' ? 'red' : log.kind === 'freeze' ? 'green' : log.kind === 'idempotent' ? 'purple' : 'gray'">{{ log.kind }}</a-tag>
        <small>{{ log.time }}</small>
        <span>{{ log.text }}</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.sync-grid{display:grid;grid-template-columns:1fr 1.25fr 1.15fr;gap:16px;align-items:start}.col{display:grid;gap:16px}.panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:12px}.panel-head h2{font-size:16px;margin:0 0 3px}.panel-head p{color:#7a8798;font-size:12px;margin:0}.hint{color:#667085;font-size:12px;line-height:1.7;margin:10px 0 0}.unit-radio{display:grid;gap:6px;margin-top:6px}.unit-radio :deep(.arco-radio){margin:0}.fault{display:block;width:100%;text-align:left;border:1px solid #e7ebf1;border-radius:7px;padding:10px 12px;margin-bottom:8px;background:#fff;cursor:pointer}.fault.active{border-color:#2563eb;background:#f5f8ff}.fault b,.fault small{display:block}.fault small{color:#7a8798;margin-top:3px}.empty{color:#94a3b8;font-size:13px;padding:14px 0;text-align:center}.batch{border:1px solid #e7ebf1;border-radius:8px;padding:12px;margin-bottom:10px}.batch.rejected{border-color:#fda4af;background:#fff6f7}.batch.failed{border-color:#fdba74;background:#fff8f0}.batch-head{display:flex;justify-content:space-between;gap:8px}.batch-head b,.batch-head small{display:block}.batch-head small{color:#7a8798;margin-top:3px}.changes{list-style:none;padding:0;margin:10px 0;display:grid;gap:6px}.changes li{display:flex;justify-content:space-between;gap:10px;font-size:13px;background:#f8fafc;border-radius:5px;padding:6px 9px}.changes em{font-style:normal;color:#475569;text-align:right}.note{display:block;color:#b45309;font-size:12px;margin:6px 0}.batch-actions{display:flex;justify-content:flex-end;gap:8px}.conflict-card{border:1px solid #fecdd3;border-radius:8px;padding:12px;margin-bottom:10px;background:#fffafa}.conflict-card.done{border-color:#e2e8f0;background:#fafbfc;opacity:.75}.conflict-head{display:flex;justify-content:space-between;margin-bottom:8px}.two-sides{display:grid;grid-template-columns:1fr 1fr;gap:8px}.side{border-radius:6px;padding:8px 10px}.side span{display:block;font-size:11px;color:#7a8798;margin-bottom:4px}.side p{margin:0;font-size:13px}.side.local{background:#f1f5f9}.side.remote{background:#eff6ff}.conflict-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:9px}.gate{display:flex;gap:10px;align-items:flex-start;padding:9px;border-radius:6px;margin-bottom:7px}.gate span{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;font-weight:800;font-size:12px;flex:none}.gate.pass{background:#f0fdf4}.gate.pass span{background:#16a34a;color:#fff}.gate.fail{background:#fef2f2}.gate.fail span{background:#e11d48;color:#fff}.gate b,.gate small{display:block}.gate small{color:#64748b;margin-top:2px}.snap{font-family:monospace;font-size:13px;margin:0 0 6px}.snapshotInvalid{border-color:#fda4af}.logline{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:13px;flex-wrap:wrap}.logline small{color:#94a3b8}.logline span{color:#334155;flex:1;min-width:200px}.mt10{margin-top:10px}.server-log{max-height:260px;overflow:auto}
@media(max-width:1200px){.sync-grid{grid-template-columns:1fr 1fr}}@media(max-width:860px){.sync-grid{grid-template-columns:1fr}}
</style>
