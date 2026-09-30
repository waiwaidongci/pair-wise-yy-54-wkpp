<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMutation } from '@vue/apollo-composable'
import { Message } from '@arco-design/web-vue'
import { COMMENTS_MUTATION } from '../graphql'
import { useSchemeStore } from '../store/scheme'
import type { OfflineBatch, Unit } from '../types'

const store = useSchemeStore()
const { mutate } = useMutation(COMMENTS_MUTATION)
const compare = ref(['ST-01', 'ST-02'])
const selectedVersion = ref('v7')
const versions = [
  { id: 'v7', author: '建设组', time: '今天 16:22', summary: '调整第二阶段夜间全封闭范围，保留急救通道' },
  { id: 'v6', author: '交通组', time: '今天 14:50', summary: '补充江海大道信号配时和现场疏导岗位' },
  { id: 'v5', author: '公交组', time: '昨天 19:10', summary: '提交临时站点与线路绕行方案' },
]

/** 冻结后会签与通告按快照判断 */
const viewStages = computed(() => store.snapshot?.status === 'frozen' ? store.snapshot.stages : store.scheme.stages)
const viewDetours = computed(() => store.snapshot?.status === 'frozen' ? store.snapshot.detours : store.scheme.detours)
const isFrozen = computed(() => store.snapshot?.status === 'frozen')
const pendingConflicts = computed(() => store.conflicts.filter((c) => !c.resolved))

function resolve(id: string, status: '已接受' | '已退回') {
  store.resolveComment(id, status)
  void mutate({ id, status })
}

function freeze() {
  const result = store.freezeSnapshot()
  if (result.ok) Message.success('审批快照已冻结')
  else Message.warning(result.reason || '无法冻结快照')
}

function exportNotice() {
  const stages = viewStages.value
  const detours = viewDetours.value
  const text = [`${store.scheme.project} 施工封路公开通告`, `范围：${store.scheme.area}`, `版本：v${isFrozen.value ? store.snapshot!.schemeVersion : store.scheme.version}`, isFrozen.value ? '（以冻结审批快照为准）' : '', '', ...stages.map((stage) => `${stage.start} 至 ${stage.end}｜${stage.name}｜${stage.lanes}`), '', '绕行建议：', ...detours.map((route) => `${route.name}，增加约 ${route.extraMinutes} 分钟`), '', '本通告由建设、交通、公交、应急单位联合确认。'].join('\n')
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `封路公开通告-${store.scheme.id}-v${isFrozen.value ? store.snapshot!.schemeVersion : store.scheme.version}.txt`
  link.click()
  URL.revokeObjectURL(link.href)
}

/** 模拟各单位离线改动回传：按现场批次合并，失败后整批重试不重复写入 */
function simulateOfflineBatch(unit: Unit) {
  const stage = store.scheme.stages[1] // ST-02
  const batch: OfflineBatch = {
    id: `BATCH-${Date.now()}`,
    unit,
    createdAt: new Date().toISOString(),
    idempotencyKey: `idem-${unit}-${stage.id}-${Date.now()}`,
    status: 'pending',
    changes: [
      {
        stageId: stage.id,
        baseVersion: stage.version,
        patch: { lanes: `${unit}单位离线调整：夜间全封闭改为半幅通行` },
        timestamp: new Date().toISOString(),
      },
    ],
  }
  store.batches.push(batch)
  const result = store.mergeBatch(batch)
  if (result.conflicts.length > 0) Message.warning(`${unit} 批次合并完成，检测到 ${result.conflicts.length} 处冲突，已保留两份`)
  else Message.success(`${unit} 离线批次已合并（应用 ${result.applied} 条）`)
}

function retryBatch(batchId: string) {
  store.retryBatch(batchId)
  const batch = store.batches.find((b) => b.id === batchId)
  if (batch?.status === 'applied') Message.success('批次重试成功')
  else Message.warning('批次重试仍失败')
}
</script>

<template>
  <section class="page-head compact"><div><p class="eyebrow">条件会签与版本批复</p><h1>路段意见与阶段审批</h1><p>各方意见锚定具体路段和几何版本，审批人可逐项接受、退回并导出公开通告包。</p></div><a-space><a-button @click="exportNotice">导出公开通告包</a-button><a-button type="primary" :disabled="!store.canFreeze || isFrozen" @click="freeze">冻结审批快照</a-button></a-space></section>
  <a-alert v-if="isFrozen" type="success" class="mb16" :title="`审批快照已冻结 · v${store.snapshot!.schemeVersion}`" content="地图、总览和公开通告均以此快照为准。冻结后车道、绕行或应急条件一变，原审批立即失效。" />
  <a-alert v-else-if="store.snapshot?.status === 'invalidated'" type="error" class="mb16" :title="`审批快照已失效`" :content="store.snapshot.invalidatedReason || '冻结后条件发生变化，原审批立即失效。'" />
  <div class="review-grid">
    <article class="card">
      <div class="panel-head"><div><h2>会签意见</h2><p>原意见不可覆盖，处理动作进入审计记录</p></div><a-tag color="orange">{{ store.scheme.comments.filter((item) => item.status === '待处理').length }} 待处理</a-tag></div>
      <button v-for="comment in store.scheme.comments" :key="comment.id" class="comment" :class="{ active: store.selectedCommentId === comment.id }" @click="store.selectedCommentId = comment.id">
        <div class="comment-head"><span>{{ comment.unit }}</span><b>{{ comment.author }}</b><a-tag :color="comment.status === '已接受' ? 'green' : comment.status === '已退回' ? 'red' : 'orange'">{{ comment.status }}</a-tag></div>
        <p>{{ comment.content }}</p><small v-if="comment.condition">条件：{{ comment.condition }}</small><em>锚点 {{ comment.segmentId }}</em>
      </button>
    </article>
    <div class="right">
      <article class="card">
        <div class="panel-head"><div><h2>阶段条件处理</h2><p>{{ store.selectedComment?.segmentId }} · {{ store.selectedComment?.unit }}</p></div></div>
        <div v-if="store.selectedComment" class="condition"><b>要求条件</b><p>{{ store.selectedComment.condition || '无附加条件' }}</p><b>影响解释</b><p>{{ store.selectedComment.content }}</p></div>
        <a-space><a-button status="danger" :disabled="store.selectedComment?.status !== '待处理'" @click="resolve(store.selectedComment!.id, '已退回')">退回方案</a-button><a-button type="primary" :disabled="store.selectedComment?.status !== '待处理'" @click="resolve(store.selectedComment!.id, '已接受')">接受条件</a-button></a-space>
      </article>

      <article class="card">
        <div class="panel-head"><div><h2>并发冲突</h2><p>同一阶段两边都改过，保留两份并标出</p></div><a-tag v-if="pendingConflicts.length" color="orange">{{ pendingConflicts.length }} 待处理</a-tag></div>
        <div v-if="!pendingConflicts.length" class="empty">暂无并发冲突</div>
        <div v-for="conflict in pendingConflicts" :key="conflict.id" class="conflict-item">
          <b>阶段 {{ conflict.stageId }} · 批次 {{ conflict.batchId }}</b>
          <div class="conflict-versions">
            <div class="version-box"><em>先到（本地）</em><p>{{ conflict.local.lanes }}</p><small>v{{ conflict.local.version }}</small></div>
            <div class="version-box remote"><em>后到（远端）</em><p>{{ conflict.remote.lanes }}</p><small>v{{ conflict.remote.version }}</small></div>
          </div>
          <a-space><a-button size="mini" @click="store.resolveConflict(conflict.id, 'local')">保留先到</a-button><a-button size="mini" type="primary" @click="store.resolveConflict(conflict.id, 'remote')">保留后到</a-button></a-space>
        </div>
      </article>

      <article class="card">
        <div class="panel-head"><div><h2>离线批次回传</h2><p>各单位离线改动按现场批次合并，失败整批重试不重复写入</p></div></div>
        <a-space wrap class="mb16"><a-button size="small" @click="simulateOfflineBatch('交通')">交通单位回传</a-button><a-button size="small" @click="simulateOfflineBatch('公交')">公交单位回传</a-button><a-button size="small" @click="simulateOfflineBatch('应急')">应急单位回传</a-button></a-space>
        <div v-for="batch in store.batches" :key="batch.id" class="batch-item">
          <div class="batch-head"><b>{{ batch.unit }} · {{ batch.id }}</b><a-tag :color="batch.status === 'applied' ? 'green' : batch.status === 'failed' ? 'red' : 'orange'">{{ batch.status }}</a-tag></div>
          <small>幂等键 {{ batch.idempotencyKey }}</small>
          <a-button v-if="batch.status === 'failed'" size="mini" type="primary" @click="retryBatch(batch.id)">整批重试</a-button>
        </div>
        <div v-if="!store.batches.length" class="empty">暂无离线批次</div>
      </article>

      <article class="card">
        <div class="panel-head"><div><h2>几何版本比较</h2><p>并排核对阶段起止、围挡与绕行</p></div><a-select v-model="selectedVersion" style="width:110px"><a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.id }}</a-option></a-select></div>
        <div class="version-list"><div v-for="version in versions" :key="version.id" :class="{ selected: selectedVersion === version.id }"><b>{{ version.id }} · {{ version.author }}</b><small>{{ version.time }}</small><p>{{ version.summary }}</p></div></div>
        <a-divider />
        <h3>阶段差异</h3><div class="diff"><a-tag color="red">修改</a-tag><span>ST-02 夜间封闭边界缩短 28 米，保留急救中心南门 4 米通道。</span></div><div class="diff"><a-tag color="green">新增</a-tag><span>江海大道口增加 2 名交通疏导员和临时信号配时方案。</span></div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.review-grid{display:grid;grid-template-columns:1fr 1.15fr;gap:16px}.right{display:grid;gap:16px;height:fit-content}.panel-head{display:flex;justify-content:space-between;margin-bottom:12px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:12px;margin:0}.comment{display:block;width:100%;text-align:left;border:1px solid #e7ebf1;background:#fff;border-radius:7px;padding:13px;margin-bottom:9px;color:inherit;cursor:pointer}.comment:hover,.comment.active{border-color:#2563eb;background:#f5f8ff}.comment-head{display:flex;align-items:center;gap:8px}.comment-head>span{display:grid;place-items:center;width:36px;height:36px;border-radius:6px;background:#eef2f7;font-weight:800}.comment-head b{flex:1}.comment p{margin:9px 0 5px;color:#475569}.comment small,.comment em{display:block;color:#7a8798}.comment em{margin-top:6px;font-style:normal}.condition p{color:#475569}.version-list>div{padding:11px;border:1px solid #edf0f5;border-radius:6px;margin-bottom:7px}.version-list>div.selected{border-color:#2563eb;background:#f5f8ff}.version-list b,.version-list small{display:block}.version-list small{color:#7a8798;margin-top:3px}.version-list p{margin:7px 0 0;color:#475569}.diff{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #edf0f5}
.empty{padding:18px;text-align:center;color:#9aa6b5;font-size:13px}.conflict-item{padding:12px;border:1px solid #ffe4e6;border-radius:7px;margin-bottom:10px;background:#fff5f6}.conflict-item>b{display:block;font-size:13px;margin-bottom:8px}.conflict-versions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}.version-box{padding:8px;border:1px solid #e1e7ef;border-radius:6px;background:#f8fafc}.version-box.remote{border-color:#fecdd3;background:#fff1f2}.version-box em{display:block;font-style:normal;font-size:11px;color:#7a8798;margin-bottom:4px}.version-box p{margin:0 0 4px;font-size:12px;color:#475569}.version-box small{color:#9aa6b5;font-size:11px}.batch-item{padding:10px;border:1px solid #edf0f5;border-radius:6px;margin-bottom:8px}.batch-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}.batch-head b{font-size:13px}.batch-item small{display:block;color:#9aa6b5;font-size:11px;margin-bottom:6px}
@media(max-width:980px){.review-grid{grid-template-columns:1fr}}
</style>
