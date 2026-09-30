<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@vue/apollo-composable'
import { SCHEME_QUERY } from '../graphql'
import { useSchemeStore } from '../store/scheme'

const store = useSchemeStore()
const { result, loading, error } = useQuery(SCHEME_QUERY)

/** 总览按审批快照判断：有生效快照时，阶段与计数全部取快照 */
const viewStages = computed(() => store.activeSnapshot?.stages ?? store.scheme.stages)
const viewComments = computed(() => store.activeSnapshot?.comments ?? store.scheme.comments)

const stats = computed(() => [
  { label: '施工阶段', value: viewStages.value.length, note: store.activeSnapshot ? `快照 ${store.activeSnapshot.id.slice(-5)} 冻结` : '跨 42 天' },
  { label: '生效冲突', value: store.conflicts.filter((item) => item.status === '待裁定').length, note: store.pendingConflicts.length ? '冲突双份保留，等待裁定' : '无合并冲突' },
  { label: '会签待处理', value: viewComments.value.filter((item) => item.status === '待处理').length, note: store.activeSnapshot ? '按冻结快照统计' : '条件闭合后方可冻结' },
  { label: '判断依据', value: store.activeSnapshot ? `r${store.activeSnapshot.revision}` : `r${store.revision}`, note: store.activeSnapshot ? '冻结审批快照' : '当前草案（未冻结）' },
])

function statusColor(status: string) {
  return status === '已批准' ? 'green' : status === '退回' || status === '冲突待裁' ? 'red' : 'orange'
}

function editLanes(id: string, value: string) {
  store.selectedStageId = id
  store.updateStage({ lanes: value })
}
</script>

<template>
  <section class="page-head">
    <div><p class="eyebrow">建设 · 交通 · 公交 · 应急</p><h1>封路方案协调总览</h1><p>在同一地图与阶段计划下核验相邻工程、生命通道、公交覆盖与绕行时延。</p></div>
    <a-space><a-button @click="$router.push('/review')">公开通告预览</a-button><a-button type="primary" @click="$router.push('/map')">编辑封路方案</a-button></a-space>
  </section>

  <a-alert v-if="store.activeSnapshot" type="success" class="mb16" :title="`总览按审批快照 ${store.activeSnapshot.id} 判断（修订号 r${store.activeSnapshot.revision}，${store.activeSnapshot.frozenBy} 于 ${store.activeSnapshot.frozenAt} 冻结）`">
    地图、本总览与公开通告使用同一份快照。冻结后车道、绕行或应急条件一变，原审批立即失效。
    <template #extra><a-button size="small" @click="$router.push('/sync')">批次与审批</a-button></template>
  </a-alert>
  <a-alert v-else-if="store.invalidSnapshot" type="error" class="mb16" :title="`原审批 ${store.invalidSnapshot.id} 已失效：${store.invalidSnapshot.invalidReason}`">
    总览已回退为当前草案，请重新核对几何与会签条件后冻结。
    <template #extra><a-button size="small" type="primary" @click="$router.push('/sync')">去重新冻结</a-button></template>
  </a-alert>

  <a-spin :loading="loading" style="width:100%">
    <a-alert v-if="error" type="error" title="GraphQL 请求异常，已使用本地草案" class="mb16" />
    <div class="metrics"><article v-for="item in stats" :key="item.label" class="card metric" :class="{ snap: store.activeSnapshot }"><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.note }}</small></article></div>
    <div class="grid-2">
      <article class="card">
        <div class="panel-head">
          <div><h2>施工阶段时间轴</h2><p>点击阶段定位地图；车道列可直接修改（与地图、会签同源）</p></div>
          <a-tag :color="store.activeSnapshot ? 'green' : 'orange'">{{ store.activeSnapshot ? '快照已批准' : '草案状态' }}</a-tag>
        </div>
        <a-table :data="viewStages" :pagination="false" row-key="id" @row-click="(row: any) => { store.selectedStageId = row.id; $router.push('/map') }">
          <template #columns>
            <a-table-column title="阶段" data-index="name" />
            <a-table-column title="时间" :width="190"><template #cell="{ record }">{{ record.start }} → {{ record.end }}</template></a-table-column>
            <a-table-column title="车道方案" :width="260">
              <template #cell="{ record }">
                <a-input v-if="!store.activeSnapshot" :model-value="record.lanes" size="small" @click.stop @change="(v: string) => editLanes(record.id, v)" />
                <span v-else>{{ record.lanes }}</span>
              </template>
            </a-table-column>
            <a-table-column title="状态" :width="100">
              <template #cell="{ record }">
                <a-tag :color="statusColor(store.activeSnapshot ? record.status : store.stageStatus(record.id))">{{ store.activeSnapshot ? record.status : store.stageStatus(record.id) }}</a-tag>
              </template>
            </a-table-column>
          </template>
        </a-table>
      </article>
      <article class="card">
        <div class="panel-head"><div><h2>规则检测结果</h2><p>合并冲突优先展示</p></div><a-tag color="red">{{ store.pendingConflicts.length }} 合并冲突</a-tag></div>
        <div v-for="item in store.pendingConflicts" :key="item.id" class="conflict red">
          <div><b>合并冲突 · {{ item.stageId }} · {{ item.fieldLabel }}</b><small>{{ item.id }} · {{ item.remoteLabel }} vs {{ item.localLabel }}</small></div>
          <a-tag color="red">双份保留</a-tag>
          <p>先入库：「{{ item.localText }}」｜后回传：「{{ item.remoteText }}」</p>
          <a-button size="mini" type="text" @click="$router.push('/sync')">前往裁定</a-button>
        </div>
        <div v-for="item in store.staticConflicts" :key="item.id" class="conflict" :class="item.level === '高' ? 'red' : 'amber'"><div><b>{{ item.title }}</b><small>{{ item.segmentId }}</small></div><a-tag :color="item.level === '高' ? 'red' : 'orange'">{{ item.level }}</a-tag><p>{{ item.detail }}</p><a-button size="mini" type="text" @click="store.selectedStageId = item.segmentId; $router.push('/map')">定位路段</a-button></div>
      </article>
    </div>
    <article class="card mt16"><div class="panel-head"><div><h2>会签单位与条件</h2><p>意见锚定具体分段与几何版本，原记录不覆盖</p></div><a-button type="text" @click="$router.push('/review')">进入会签</a-button></div><div class="agency-grid"><div v-for="agency in result?.agencies || []" :key="agency.id" class="agency"><span>{{ agency.role }}</span><div><b>{{ agency.name }}</b><small>{{ store.scheme.comments.filter((c) => c.unit === agency.role && c.status === '待处理').length }} 条待处理</small></div><a-tag :color="store.scheme.comments.some((c) => c.unit === agency.role && c.status === '待处理') ? 'orange' : 'green'">{{ store.scheme.comments.some((c) => c.unit === agency.role && c.status === '待处理') ? '待处理' : '已响应' }}</a-tag></div></div></article>
  </a-spin>
</template>

<style scoped>
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.metric{padding:17px;border-left:4px solid #2563eb}.metric.snap{border-left-color:#16a34a;background:#f0fdf4}.metric span,.metric small{display:block;color:#667085}.metric.snap small{color:#15803d}.metric strong{display:block;font-size:29px;margin:7px 0 2px}.grid-2{display:grid;grid-template-columns:1.4fr .8fr;gap:16px}.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:13px;margin:0}.conflict{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px;margin-bottom:9px;border-radius:6px}.conflict.red{background:#fff1f2;border-left:3px solid #e11d48}.conflict.amber{background:#fff7ed;border-left:3px solid #f59e0b}.conflict>div{min-width:210px}.conflict b,.conflict small{display:block}.conflict small{color:#7a8798;margin-top:3px}.conflict p{width:100%;margin:0;color:#475569}.mt16{margin-top:16px}.agency-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.agency{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #e7ebf1;border-radius:7px}.agency>span{display:grid;place-items:center;width:35px;height:35px;border-radius:7px;background:#eff6ff;color:#2563eb;font-weight:800}.agency b,.agency small{display:block}.agency small{color:#7a8798;margin-top:3px}.agency>div{flex:1}
@media(max-width:1050px){.metrics,.agency-grid{grid-template-columns:1fr 1fr}.grid-2{grid-template-columns:1fr}}@media(max-width:600px){.metrics,.agency-grid{grid-template-columns:1fr}}
</style>
