<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSchemeStore } from '../store/scheme'
import { geometryHash } from '../lib/sync'

const store = useSchemeStore()
const selectedVersion = ref('v7')
const noticeBlocked = ref('')
const versions = [
  { id: 'v7', author: '建设组', time: '今天 16:22', summary: '调整第二阶段夜间全封闭范围，保留急救通道' },
  { id: 'v6', author: '交通组', time: '今天 14:50', summary: '补充江海大道信号配时和现场疏导岗位' },
  { id: 'v5', author: '公交组', time: '昨天 19:10', summary: '提交临时站点与线路绕行方案' },
]

function resolve(id: string, status: '已接受' | '已退回') {
  store.resolveComment(id, status)
}

/** 重新处理已接受 / 已退回意见：应急条件变化会在冻结后令原审批立即失效 */
function reopen(id: string) {
  store.reopenComment(id)
}

/** 应急单位修订会签条件 */
function reviseCondition(id: string, value: string) {
  store.reviseCommentCondition(id, value)
}

/** 会签单位身份：用于判断是否允许修订条件 */
function isEmergency(id: string) {
  return store.scheme.comments.find((c) => c.id === id)?.unit === '应急'
}

function anchoredState(anchoredHash?: string, segmentId?: string) {
  if (!anchoredHash || !segmentId) return { text: '未锚定', color: 'gray' as const }
  const stage = store.scheme.stages.find((s) => s.id === segmentId)
  if (!stage) return { text: '锚点丢失', color: 'red' as const }
  return geometryHash(stage) === anchoredHash
    ? { text: `几何一致 ${anchoredHash.slice(0, 8)}`, color: 'green' as const }
    : { text: `几何已漂移 ${anchoredHash.slice(0, 8)}`, color: 'red' as const }
}

const commentList = computed(() => store.activeSnapshot?.comments ?? store.scheme.comments)

/** 公开通告只按生效审批快照判断：无快照 / 快照失效一律不得导出 */
function exportNotice() {
  noticeBlocked.value = ''
  const snapshot = store.activeSnapshot
  if (!snapshot) {
    noticeBlocked.value = store.invalidSnapshot
      ? `审批快照 ${store.invalidSnapshot.id} 已失效（${store.invalidSnapshot.invalidReason}），公开通告不得按旧审批发布，请重新冻结。`
      : '尚未冻结审批快照：地图、总览、通告必须基于同一份冻结快照，当前只能导出草案预览。'
    return
  }
  const text = [
    `${store.scheme.project} 施工封路公开通告`,
    `范围：${store.scheme.area}`,
    `审批快照：${snapshot.id}（修订号 r${snapshot.revision}，${snapshot.frozenBy} 于 ${snapshot.frozenAt} 冻结）`,
    '',
    ...snapshot.stages.map((stage) => `${stage.start} 至 ${stage.end}｜${stage.name}｜${stage.lanes}｜状态：${stage.status}`),
    '',
    '绕行建议（按冻结快照）：',
    ...snapshot.detours.map((route) => `${route.name}，增加约 ${route.extraMinutes} 分钟`),
    '',
    '会签条件（按冻结快照）：',
    ...snapshot.comments.map((c) => `[${c.unit}·${c.status}] ${c.segmentId}：${c.condition ?? '无附加条件'}`),
    '',
    '本通告由建设、交通、公交、应急单位联合确认。冻结后车道、绕行或应急条件变化时，本审批立即失效。',
  ].join('\n')
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `封路公开通告-${store.scheme.id}-${snapshot.id}.txt`
  link.click()
  URL.revokeObjectURL(link.href)
}
</script>

<template>
  <section class="page-head compact">
    <div>
      <p class="eyebrow">条件会签与版本批复</p>
      <h1>路段意见与阶段审批</h1>
      <p>意见锚定具体路段与接受时刻的几何；接受条件后几何再变即标为漂移，几何与会签条件一致才能冻结。</p>
    </div>
    <a-space>
      <a-button :disabled="!store.canFreeze" @click="store.freeze()">冻结审批快照</a-button>
      <a-button type="primary" :status="store.activeSnapshot ? 'success' : 'warning'" @click="exportNotice">{{ store.activeSnapshot ? '按快照导出公开通告' : '导出通告（需快照）' }}</a-button>
    </a-space>
  </section>

  <a-alert v-if="store.activeSnapshot" type="success" class="mb16" :title="`会签页按审批快照 ${store.activeSnapshot.id} 展示；公开通告将使用这份冻结内容。`" />
  <a-alert v-else-if="store.invalidSnapshot" type="error" class="mb16" :title="`原审批已失效：${store.invalidSnapshot.invalidReason}`" />
  <a-alert v-if="noticeBlocked" type="warning" closable class="mb16" :title="noticeBlocked" @close="noticeBlocked = ''" />
  <a-alert v-if="!store.online" type="info" class="mb16" title="离线中：接受 / 退回动作进入现场批次，恢复连接回传后才会更新会签结论。" />

  <div class="review-grid">
    <article class="card">
      <div class="panel-head"><div><h2>会签意见</h2><p>原意见不可覆盖，处理动作进入批次与审计</p></div><a-tag color="orange">{{ store.scheme.comments.filter((item) => item.status === '待处理').length }} 待处理</a-tag></div>
      <button v-for="comment in commentList" :key="comment.id" class="comment" :class="{ active: store.selectedCommentId === comment.id }" @click="store.selectedCommentId = comment.id">
        <div class="comment-head"><span>{{ comment.unit }}</span><b>{{ comment.author }}</b><a-tag :color="comment.status === '已接受' ? 'green' : comment.status === '已退回' ? 'red' : 'orange'">{{ comment.status }}</a-tag></div>
        <p>{{ comment.content }}</p><small v-if="comment.condition">条件：{{ comment.condition }}</small>
        <em>锚点 {{ comment.segmentId }} · <a-tag size="small" :color="anchoredState(comment.anchoredHash, comment.segmentId).color">{{ anchoredState(comment.anchoredHash, comment.segmentId).text }}</a-tag></em>
      </button>
    </article>
    <div class="right">
      <article class="card">
        <div class="panel-head"><div><h2>阶段条件处理</h2><p>{{ store.selectedComment?.segmentId }} · {{ store.selectedComment?.unit }}</p></div><a-tag v-if="store.selectedComment" :color="anchoredState(store.selectedComment.anchoredHash, store.selectedComment.segmentId).color">{{ anchoredState(store.selectedComment.anchoredHash, store.selectedComment.segmentId).text }}</a-tag></div>
        <div v-if="store.selectedComment" class="condition"><b>要求条件</b>
          <a-textarea v-if="isEmergency(store.selectedComment.id)" :model-value="store.activeSnapshot ? store.selectedComment.condition : store.selectedComment.condition" :auto-size="{ minRows: 2, maxRows: 4 }" @change="(v: string) => reviseCondition(store.selectedComment!.id, v)" />
          <p v-else>{{ store.selectedComment.condition || '无附加条件' }}</p>
          <b>影响解释</b><p>{{ store.selectedComment.content }}</p><p class="anchor-note">点击「接受条件」会把当前阶段几何哈希锚定到该意见；之后若地图几何再变，冻结闸门将判定不一致。应急条件在冻结后一旦修订，原审批立即失效。</p></div>
        <a-space>
          <a-button v-if="store.selectedComment?.status !== '待处理' && !store.activeSnapshot" size="small" @click="reopen(store.selectedComment!.id)">重新提请会签</a-button>
          <a-button status="danger" :disabled="store.selectedComment?.status !== '待处理' || !!store.activeSnapshot" @click="resolve(store.selectedComment!.id, '已退回')">退回方案</a-button>
          <a-button type="primary" :disabled="store.selectedComment?.status !== '待处理' || !!store.activeSnapshot" @click="resolve(store.selectedComment!.id, '已接受')">接受条件并锚定几何</a-button>
        </a-space>
        <small v-if="store.activeSnapshot" class="note">快照冻结期间会签结论只读；在上方修订应急条件即令原审批失效，随后重新冻结。</small>
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
.review-grid{display:grid;grid-template-columns:1fr 1.15fr;gap:16px}.right{display:grid;gap:16px;height:fit-content}.panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:12px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:12px;margin:0}.comment{display:block;width:100%;text-align:left;border:1px solid #e7ebf1;background:#fff;border-radius:7px;padding:13px;margin-bottom:9px;color:inherit;cursor:pointer}.comment:hover,.comment.active{border-color:#2563eb;background:#f5f8ff}.comment-head{display:flex;align-items:center;gap:8px}.comment-head>span{display:grid;place-items:center;width:36px;height:36px;border-radius:6px;background:#eef2f7;font-weight:800}.comment-head b{flex:1}.comment p{margin:9px 0 5px;color:#475569}.comment small,.comment em{display:block;color:#7a8798}.comment em{margin-top:6px;font-style:normal}.condition p{color:#475569}.anchor-note{font-size:12px;color:#94a3b8}.note{display:block;color:#b45309;font-size:12px;margin-top:10px}.version-list>div{padding:11px;border:1px solid #edf0f5;border-radius:6px;margin-bottom:7px}.version-list>div.selected{border-color:#2563eb;background:#f5f8ff}.version-list b,.version-list small{display:block}.version-list small{color:#7a8798;margin-top:3px}.version-list p{margin:7px 0 0;color:#475569}.diff{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #edf0f5}
@media(max-width:980px){.review-grid{grid-template-columns:1fr}}
</style>
