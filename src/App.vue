<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import { useSchemeStore } from './store/scheme'

const route = useRoute()
const router = useRouter()
const store = useSchemeStore()
const nav = [
  { name: 'overview', label: '方案总览' },
  { name: 'map', label: '地图与阶段' },
  { name: 'review', label: '多单位会签' },
]

function freeze() {
  const result = store.freezeSnapshot()
  if (result.ok) Message.success('审批快照已冻结，地图、总览与公开通告将以此为准')
  else Message.warning(result.reason || '无法冻结快照')
}
</script>

<template>
  <a-layout class="shell">
    <a-layout-sider :width="224" class="sider">
      <div class="brand"><b>路</b><div><strong>封路协调台</strong><small>ROAD CONTROL</small></div></div>
      <a-menu :selected-keys="[route.name]" class="menu" @menu-item-click="(key: string) => router.push({ name: key })">
        <a-menu-item v-for="item in nav" :key="item.name">{{ item.label }}</a-menu-item>
      </a-menu>
      <div class="project-card"><span></span><div><b>{{ store.scheme.project }}</b><small>草案 v{{ store.scheme.version }} · 4 家单位会签</small></div></div>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="topbar">
        <div><b>{{ store.scheme.id }}</b><span>{{ store.scheme.area }} · 2026 年第四季度施工计划</span></div>
        <div class="top-actions">
          <a-tag v-if="store.snapshot?.status === 'frozen'" color="green">审批快照已冻结 · v{{ store.snapshot.schemeVersion }}</a-tag>
          <a-tag v-else-if="store.snapshot?.status === 'invalidated'" color="red">快照已失效</a-tag>
          <a-tag v-if="store.conflicts.filter(c => !c.resolved).length" color="orange">{{ store.conflicts.filter(c => !c.resolved).length }} 处冲突待处理</a-tag>
          <a-tag color="green">协同在线 11</a-tag>
          <a-button :disabled="!store.dirty" @click="store.undo">撤销修改</a-button>
          <a-button type="primary" :disabled="!store.canFreeze || store.snapshot?.status === 'frozen'" @click="freeze">冻结审批快照</a-button>
        </div>
      </a-layout-header>
      <a-layout-content class="main"><router-view /></a-layout-content>
    </a-layout>
  </a-layout>
</template>
