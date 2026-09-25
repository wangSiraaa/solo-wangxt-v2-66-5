<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  checkPublishability,
  currentContent,
  deriveWorkspace,
  latestVersion,
  publishSnapshot,
  snapshotLabel,
  state,
  unitLabel,
} from '../store'
import { diffContents, type EntityChange, type SnapshotContent } from '../snapshot'
import type { Relation, Retraction, Snapshot } from '../types'

/* ---------- 发布 ---------- */

const note = ref('')

const precheck = computed(() => checkPublishability())

async function publish() {
  const v = await publishSnapshot(note.value)
  if (v !== null) note.value = ''
}

/* ---------- 差异审查 ---------- */

const sideA = ref<number | 'workspace'>('workspace')
const sideB = ref<number | 'workspace' | ''>('')

const options = computed(() => [...state.snapshots].reverse())

function resolveSide(side: number | 'workspace'): SnapshotContent | null {
  return side === 'workspace' ? currentContent() : state.snapshots.find((s) => s.version === side)?.content ?? null
}

const diff = computed(() => {
  if (sideB.value === '' || sideB.value === sideA.value) return null
  const a = resolveSide(sideA.value)
  const b = resolveSide(sideB.value as number | 'workspace')
  if (!a || !b) return null
  return diffContents(a, b)
})

function swapSides() {
  if (sideB.value === '') return
  const tmp = sideA.value
  sideA.value = sideB.value as number | 'workspace'
  sideB.value = tmp === 'workspace' ? 'workspace' : (tmp as number)
}

const changeText: Record<string, string> = { added: '新增', removed: '删除', modified: '修改' }

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

function shortDigest(s: Snapshot): string {
  return s.digest.slice(0, 10)
}

/* ---------- 实体变化描述 ---------- */

function unitChange(c: EntityChange<{ id: string; label: string; type: string; note: string }>): string {
  const b = c.after ?? c.before!
  const action = changeText[c.kind]
  if (c.kind === 'modified') {
    const fields: string[] = []
    if (c.before!.label !== c.after!.label) fields.push(`编号 ${c.before!.label}→${c.after!.label}`)
    if (c.before!.type !== c.after!.type) fields.push(`类型 ${c.before!.type}→${c.after!.type}`)
    if (c.before!.note !== c.after!.note) fields.push('备注已修改')
    return `层位 ${b.label}：${fields.join('，') || '属性变化'}`
  }
  return `${action}层位 ${b.label}`
}

function posChange(c: EntityChange<{ unitId: string; x: number; y: number }>): string {
  const id = c.after?.unitId ?? c.before!.unitId
  if (c.kind === 'modified') {
    return `层位 ${unitLabel(id)} 位置 (${Math.round(c.before!.x)}, ${Math.round(c.before!.y)}) → (${Math.round(
      c.after!.x,
    )}, ${Math.round(c.after!.y)})`
  }
  return `${changeText[c.kind]}层位 ${unitLabel(id)} 的位置`
}

function evChange(c: EntityChange<{ id: string; ref: string }>): string {
  const b = c.after ?? c.before!
  return c.kind === 'modified' ? `证据 ${b.ref} 已修改` : `${changeText[c.kind]}证据 ${b.ref}`
}

function retractionChange(c: EntityChange<Retraction>): string {
  const b = c.after ?? c.before!
  const s = b.snapshot
  return `${changeText[c.kind]}撤回记录（${unitLabel(s.from)}→${unitLabel(s.to)}：${b.reason}）`
}

/* ---------- 直接关系变化描述 ---------- */

function relationChange(c: EntityChange<Relation>): string[] {
  const b = c.after ?? c.before!
  const head = `${changeText[c.kind]}关系 ${b.from}→${b.to}（${b.kind === 'earlier' ? '早于' : '同期'}）`
  if (c.kind !== 'modified') return [head]
  const fields: string[] = []
  if (c.before!.status !== c.after!.status) {
    fields.push(`状态 ${c.before!.status === 'active' ? '活跃' : '已撤回'} → ${c.after!.status === 'active' ? '活跃' : '已撤回'}`)
  }
  if (c.before!.conflict !== c.after!.conflict) {
    fields.push(`冲突标记 ${c.after!.conflict ? '置为矛盾' : '解除矛盾'}`)
  }
  if (c.before!.source !== c.after!.source) {
    fields.push(`来源 ${c.before!.source} → ${c.after!.source}`)
  }
  if (JSON.stringify(c.before!.evidenceIds) !== JSON.stringify(c.after!.evidenceIds)) {
    fields.push('证据引用变化')
  }
  if (c.before!.note !== c.after!.note) fields.push('备注变化')
  if (c.before!.from !== c.after!.from || c.before!.to !== c.after!.to) fields.push('端点变化')
  return [`${head}：${fields.join('，') || '属性变化'}`]
}

function relationPairText(pair: string): string {
  const [from, to] = pair.split('→')
  return `${unitLabel(from)} → ${unitLabel(to)}`
}

async function derive(s: Snapshot) {
  if (
    window.confirm(
      `从快照 v${s.version} 派生新工作区？当前工作区的未发布修改将被替换（已发布快照不会被改动）。`,
    )
  ) {
    await deriveWorkspace(s.version)
    sideA.value = 'workspace'
    sideB.value = s.version
  }
}
</script>

<template>
  <section class="panel">
    <h3>发布快照</h3>
    <div class="form">
      <input v-model="note" placeholder="版本说明（可选）" @keydown.enter="publish" />
      <button :disabled="precheck.blocked" @click="publish">发布当前工作区为只读快照</button>
    </div>
    <div v-if="precheck.blocked" class="block-list">
      <p class="block-title">发布被阻止，需先修复以下问题（{{ precheck.reasons.length }}）：</p>
      <ul>
        <li v-for="(r, i) in precheck.reasons" :key="i">{{ r }}</li>
      </ul>
    </div>
    <p v-else class="hint">
      当前工作区基线：<b>{{ snapshotLabel(state.workspaceBase) }}</b>；下一版本号 v{{ latestVersion + 1 }}
    </p>
  </section>

  <section class="panel">
    <h3>发布历史（{{ state.snapshots.length }}）</h3>
    <ul class="list snap-list">
      <li v-for="s in options" :key="s.version" :class="{ base: state.workspaceBase === s.version }">
        <div class="grow">
          <b>v{{ s.version }}</b>
          <span class="tag" v-if="state.workspaceBase === s.version">当前基线</span>
          <span class="tag tampered" v-for="p in state.snapshotProblems[s.version]" :key="p" title="内容与摘要不符">
            已篡改
          </span>
          <span class="tag ok" v-if="!state.snapshotProblems[s.version]">摘要完好</span>
          <template v-if="s.note">　{{ s.note }}</template>
          <br />
          <small class="muted">
            {{ fmtTime(s.publishedAt) }}　摘要 {{ shortDigest(s) }}…<br />
            上一版 {{ s.parentVersion !== null ? 'v' + s.parentVersion : '无' }}；
            派生自 {{ s.derivedFromVersion !== null ? 'v' + s.derivedFromVersion : '独立工作区' }}<br />
            层位 {{ s.content.units.length }} / 关系 {{ s.content.relations.length }} /
            闭包 {{ s.content.partialOrder.length }} 对
          </small>
        </div>
        <button class="sm" @click="derive(s)">派生工作区</button>
      </li>
      <li v-if="state.snapshots.length === 0" class="muted">尚未发布过快照</li>
    </ul>
  </section>

  <section class="panel">
    <h3>差异审查</h3>
    <div class="row compare-row">
      <select v-model="sideA">
        <option value="workspace">当前工作区</option>
        <option v-for="s in state.snapshots" :key="s.version" :value="s.version">快照 v{{ s.version }}</option>
      </select>
      <button class="sm" title="交换两侧" @click="swapSides">⇄</button>
      <select v-model="sideB">
        <option value="" disabled>选择对照…</option>
        <option value="workspace">当前工作区</option>
        <option v-for="s in state.snapshots" :key="s.version" :value="s.version">快照 v{{ s.version }}</option>
      </select>
    </div>

    <div v-if="diff" class="diff">
      <p v-if="diff.isEmpty" class="muted">两侧内容完全一致，无差异。</p>

      <template v-else>
        <div v-if="diff.units.length" class="diff-group">
          <h4>① 层位实体变化（{{ diff.units.length }}）</h4>
          <ul>
            <li v-for="(c, i) in diff.units" :key="'u' + i" :class="c.kind">{{ unitChange(c) }}</li>
          </ul>
        </div>
        <div v-if="diff.positions.length" class="diff-group">
          <h4>① 位置变化（{{ diff.positions.length }}）</h4>
          <ul>
            <li v-for="(c, i) in diff.positions" :key="'p' + i" :class="c.kind">{{ posChange(c) }}</li>
          </ul>
        </div>
        <div v-if="diff.evidences.length" class="diff-group">
          <h4>① 证据变化（{{ diff.evidences.length }}）</h4>
          <ul>
            <li v-for="(c, i) in diff.evidences" :key="'e' + i" :class="c.kind">{{ evChange(c) }}</li>
          </ul>
        </div>
        <div v-if="diff.retractions.length" class="diff-group">
          <h4>① 撤回记录变化（{{ diff.retractions.length }}）</h4>
          <ul>
            <li v-for="(c, i) in diff.retractions" :key="'x' + i" :class="c.kind">{{ retractionChange(c) }}</li>
          </ul>
        </div>

        <div v-if="diff.relations.length" class="diff-group">
          <h4>② 直接关系记录变化（{{ diff.relations.length }}）</h4>
          <ul>
            <template v-for="(c, i) in diff.relations" :key="'r' + i">
              <li v-for="(line, j) in relationChange(c)" :key="'r' + i + '-' + j" :class="c.kind">{{ line }}</li>
            </template>
          </ul>
        </div>

        <div v-if="diff.directEdgePairs.length" class="diff-group">
          <h4>直接先后边增删（{{ diff.directEdgePairs.length }}）</h4>
          <ul>
            <li v-for="(c, i) in diff.directEdgePairs" :key="'d' + i" :class="c.kind">
              {{ c.kind === 'added' ? '＋' : '－' }} {{ relationPairText(c.pair) }}
              <span
                v-if="diff.directPairsWithoutSemanticEffect.some((x) => x.pair === c.pair)"
                class="tag hidden"
                title="该边为传递冗余边，增删不改变偏序闭包"
                >无语义影响</span
              >
            </li>
          </ul>
        </div>

        <div v-if="diff.semanticClosure.length" class="diff-group semantic">
          <h4>③ 仅由闭包推导的语义变化（{{ diff.semanticClosure.length }}）</h4>
          <ul>
            <li v-for="(c, i) in diff.semanticClosure" :key="'c' + i" :class="c.kind">
              {{ c.kind === 'added' ? '新增推导：' : '失去推导：' }}{{ relationPairText(c.pair) }}
            </li>
          </ul>
        </div>
      </template>
    </div>
    <p v-else class="hint">请选择两个快照，或一个快照与当前工作区进行比较。</p>
  </section>
</template>

<style scoped>
.hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #888;
}
.block-list {
  margin-top: 6px;
  border: 1px solid #f5c6c0;
  background: #fdecea;
  border-radius: 6px;
  padding: 6px 10px;
}
.block-title {
  margin: 2px 0 4px;
  color: #c62828;
  font-size: 12px;
}
.block-list ul {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: #a02020;
}
.snap-list li.base {
  border-color: #1e88e5;
  background: #eef6ff;
}
.tag.ok {
  border-color: #2e7d32;
  color: #2e7d32;
}
.tag.tampered {
  border-color: #c62828;
  color: #fff;
  background: #c62828;
}
.compare-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.compare-row select {
  flex: 1;
}
.diff-group {
  margin-top: 8px;
}
.diff-group h4 {
  margin: 6px 0 3px;
  font-size: 12px;
  color: #6d5c47;
}
.diff-group ul {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
}
.diff-group li {
  padding: 1px 0;
  list-style: none;
  margin-left: -12px;
}
.diff-group li.added {
  color: #2e7d32;
}
.diff-group li.removed {
  color: #c62828;
}
.diff-group li.modified {
  color: #b26a00;
}
.diff-group.semantic {
  border-top: 1px dashed #ccc;
  padding-top: 4px;
}
.diff-group.semantic h4 {
  color: #6a1b9a;
}
.diff-group.semantic li {
  color: #6a1b9a;
}
</style>
