<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useSchemeStore } from './store/scheme'

const route = useRoute()
const router = useRouter()
const store = useSchemeStore()
const nav = [
  { name: 'overview', label: '方案总览' },
  { name: 'map', label: '地图与阶段' },
  { name: 'review', label: '多单位会签' },
  { name: 'sync', label: '批次与审批' },
]
</script>

<template>
  <a-layout class="shell">
    <a-layout-sider :width="224" class="sider">
      <div class="brand"><b>路</b><div><strong>封路协调台</strong><small>ROAD CONTROL</small></div></div>
      <a-menu :selected-keys="[route.name]" class="menu" @menu-item-click="(key: string) => router.push({ name: key })">
        <a-menu-item v-for="item in nav" :key="item.name">{{ item.label }}</a-menu-item>
      </a-menu>
      <div class="project-card">
        <span :style="{ background: store.online ? '#22c55e' : '#f59e0b' }"></span>
        <div>
          <b>{{ store.scheme.project }}</b>
          <small>{{ store.online ? '在线协同' : '离线作业中' }} · r{{ store.revision }} · {{ store.currentUnit }}单位</small>
          <small v-if="store.activeSnapshot" style="color:#22c55e">审批快照 {{ store.activeSnapshot.id }} 生效中</small>
          <small v-else-if="store.invalidSnapshot" style="color:#f87171">原审批快照已失效，待重新冻结</small>
        </div>
      </div>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="topbar">
        <div><b>{{ store.scheme.id }}</b><span>{{ store.scheme.area }} · 2026 年第四季度施工计划</span></div>
        <div class="top-actions">
          <a-tag :color="store.online ? 'green' : 'orange'">{{ store.online ? '协同在线 11' : `离线 · ${store.batches.length} 批待回传` }}</a-tag>
          <a-tag v-if="store.pendingConflicts.length" color="red">{{ store.pendingConflicts.length }} 冲突待裁</a-tag>
          <a-button :disabled="!store.dirty" @click="store.undo">撤销修改</a-button>
          <a-button type="primary" @click="$router.push('/sync')">批次与审批</a-button>
        </div>
      </a-layout-header>
      <a-layout-content class="main">
        <a-alert v-if="store.lastError" :title="store.lastError" type="warning" closable class="mb16" @close="store.clearError()" />
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>
