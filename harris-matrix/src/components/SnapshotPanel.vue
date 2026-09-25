<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  compareTargets,
  deriveFromSnapshot,
  publishBlockers,
  publishSnapshot,
  state,
  unitLabel,
} from '../store'
import type { Relation, Snapshot, SnapshotDiff, StratUnit } from '../types'

const note = ref('')
const publishing = ref(false)

/** 差异审查的两个对象：'workspace' 或快照 id */
const targetA = ref<string>('workspace')
const targetB = ref<string>('workspace')

// 默认对比：最新已发布快照 → 当前工作区（快照为异步加载，待其就绪后设定一次）
const stopDefault = watch(
  () => state.snapshots.length,
  (n) => {
    if (n > 0) {
      if (targetA.value === 'workspace') targetA.value = state.snapshots[n - 1].id
      stopDefault()
    }
  },
  { immediate: true },
)

const diff = computed<SnapshotDiff | null>(() => compareTargets(targetA.value, targetB.value))

const hasEntityDiff = computed(
  () =>
    !!diff.value &&
    (diff.value.units.added.length > 0 ||
      diff.value.units.removed.length > 0 ||
      diff.value.units.changed.length > 0 ||
      diff.value.positions.added.length > 0 ||
      diff.value.positions.removed.length > 0 ||
      diff.value.positions.moved.length > 0),
)
const hasRelationDiff = computed(
  () =>
    !!diff.value &&
    (diff.value.relations.added.length > 0 ||
      diff.value.relations.removed.length > 0 ||
      diff.value.relations.changed.length > 0),
)
const hasClosureDiff = computed(
  () => !!diff.value && (diff.value.closure.addedPairs.length > 0 || diff.value.closure.removedPairs.length > 0),
)
const hasAnyDiff = computed(() => hasEntityDiff.value || hasRelationDiff.value || hasClosureDiff.value)

async function publish() {
  publishing.value = true
  try {
    const res = await publishSnapshot(note.value)
    if (res.ok && res.snapshot) {
      note.value = ''
      targetA.value = res.snapshot.id
    }
  } finally {
    publishing.value = false
  }
}

function derive(s: Snapshot) {
  const msg = `以快照 v${s.version} 的内容替换当前工作区？\n该操作会登记为一个批次（可整体撤销），不会改动任何已发布快照。`
  if (window.confirm(msg)) void deriveFromSnapshot(s.id)
}

function snapshotBad(s: Snapshot): boolean {
  return state.snapshotIssues.some((m) => m.startsWith(`v${s.version}：`))
}

function targetName(target: string): string {
  if (target === 'workspace') return '当前工作区'
  const s = state.snapshots.find((x) => x.id === target)
  return s ? `快照 v${s.version}` : target
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

function pairText(p: string): string {
  const [from, to] = p.split('→')
  return `${unitLabel(from)} → ${unitLabel(to)}`
}

function describeRel(r: Relation): string {
  return r.kind === 'earlier'
    ? `${unitLabel(r.from)} 早于 ${unitLabel(r.to)}`
    : `${unitLabel(r.from)} ≈ ${unitLabel(r.to)}（同期）`
}

const unitFieldNames: Record<string, string> = { label: '编号', type: '类型', note: '备注' }
const relFieldNames: Record<string, string> = {
  status: '状态',
  conflict: '矛盾标记',
  evidenceIds: '证据引用',
  note: '备注',
  kind: '种类',
  source: '来源',
}

function changedFields(before: object, after: object, names: Record<string, string>): string {
  const b = before as Record<string, unknown>
  const a = after as Record<string, unknown>
  return Object.keys(names)
    .filter((f) => JSON.stringify(b[f]) !== JSON.stringify(a[f]))
    .map((f) => names[f])
    .join('、')
}

function unitChangeText(c: { before: StratUnit; after: StratUnit }): string {
  return changedFields(c.before, c.after, unitFieldNames)
}

function relChangeText(c: { before: Relation; after: Relation }): string {
  const fields = changedFields(c.before, c.after, relFieldNames)
  const status =
    c.before.status !== c.after.status ? (c.after.status === 'retracted' ? '（已撤销）' : '（恢复活跃）') : ''
  return `${fields}${status}`
}
</script>

<template>
  <section class="panel">
    <h3>发布快照</h3>
    <div v-if="publishBlockers.length > 0" class="blockers">
      <b>发布被阻止（{{ publishBlockers.length }} 项）：</b>
      <ul>
        <li v-for="(b, i) in publishBlockers" :key="i">{{ b.message }}</li>
      </ul>
    </div>
    <form class="form" @submit.prevent="publish">
      <input v-model="note" placeholder="发布说明（如：发掘第 3 天归档）" />
      <button type="submit" :disabled="publishing || publishBlockers.length > 0">发布为只读快照</button>
    </form>
    <p class="hint">封存当前层位、位置、全部关系与冲突状态；版本号单调递增，内容摘要链式衔接，篡改可识别。</p>
  </section>

  <section class="panel">
    <h3>已发布快照（{{ state.snapshots.length }}）</h3>
    <p v-if="state.snapshotIssues.length > 0" class="chain-bad">
      <b>发布链校验未通过：</b>
      <br />
      <span v-for="(m, i) in state.snapshotIssues" :key="i">· {{ m }}<br /></span>
    </p>
    <p v-else-if="state.snapshots.length > 0" class="chain-ok">链校验通过：版本连续、摘要衔接、内容未被篡改。</p>
    <ul class="list">
      <li v-for="s in [...state.snapshots].reverse()" :key="s.id">
        <span class="grow">
          <b>v{{ s.version }}</b>
          <span v-if="snapshotBad(s)" class="tag conflict">校验失败</span>
          <br />
          <small>{{ s.note || '（无说明）' }}</small>
          <br />
          <small class="muted">{{ fmtTime(s.createdAt) }}　摘要 {{ s.digest.slice(0, 12) }}…</small>
        </span>
        <button class="sm" title="以此快照内容替换当前工作区（可撤销）" @click="derive(s)">派生</button>
      </li>
      <li v-if="state.snapshots.length === 0" class="muted">暂无快照</li>
    </ul>
  </section>

  <section class="panel">
    <h3>差异审查</h3>
    <div class="form">
      <div class="row">
        <select v-model="targetA">
          <option value="workspace">当前工作区</option>
          <option v-for="s in state.snapshots" :key="s.id" :value="s.id">快照 v{{ s.version }}　{{ s.note }}</option>
        </select>
        <span class="arrow">→</span>
        <select v-model="targetB">
          <option value="workspace">当前工作区</option>
          <option v-for="s in state.snapshots" :key="s.id" :value="s.id">快照 v{{ s.version }}　{{ s.note }}</option>
        </select>
      </div>
    </div>
    <template v-if="diff">
      <p v-if="!hasAnyDiff" class="muted">「{{ targetName(targetA) }}」与「{{ targetName(targetB) }}」内容一致。</p>
      <div v-else class="diff">
        <h4>实体变化</h4>
        <ul v-if="hasEntityDiff" class="list">
          <li v-for="u in diff.units.added" :key="'ua' + u.id">＋ 层位 {{ u.label }}（新增）</li>
          <li v-for="u in diff.units.removed" :key="'ur' + u.id">－ 层位 {{ u.label }}（移除）</li>
          <li v-for="c in diff.units.changed" :key="'uc' + c.after.id">
            ～ 层位 {{ c.after.label }}：{{ unitChangeText(c) }}
          </li>
          <li v-for="p in diff.positions.added" :key="'pa' + p.unitId">＋ 层位 {{ unitLabel(p.unitId) }} 的位置记录</li>
          <li v-for="p in diff.positions.removed" :key="'pr' + p.unitId">
            － 层位 {{ unitLabel(p.unitId) }} 的位置记录
          </li>
          <li v-for="m in diff.positions.moved" :key="'pm' + m.unitId">
            ⇄ 层位 {{ unitLabel(m.unitId) }} 位置移动（{{ Math.round(m.before.x) }},{{ Math.round(m.before.y) }} →
            {{ Math.round(m.after.x) }},{{ Math.round(m.after.y) }}）
          </li>
        </ul>
        <p v-else class="muted none">无</p>

        <h4>直接关系变化</h4>
        <ul v-if="hasRelationDiff" class="list">
          <li v-for="r in diff.relations.added" :key="'ra' + r.id">＋ {{ describeRel(r) }}</li>
          <li v-for="r in diff.relations.removed" :key="'rr' + r.id">－ {{ describeRel(r) }}</li>
          <li v-for="c in diff.relations.changed" :key="'rc' + c.after.id">
            ～ {{ describeRel(c.after) }}：{{ relChangeText(c) }}
          </li>
        </ul>
        <p v-else class="muted none">无</p>

        <h4>语义变化（仅由闭包推导）</h4>
        <ul v-if="hasClosureDiff" class="list">
          <li v-for="p in diff.closure.addedPairs" :key="'ca' + p">＋ {{ pairText(p) }}（变为可推导）</li>
          <li v-for="p in diff.closure.removedPairs" :key="'cr' + p">－ {{ pairText(p) }}（不再可推导）</li>
        </ul>
        <p v-else class="muted none">无</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.blockers {
  border: 1px solid #f5c6c0;
  background: #fdecea;
  color: #b3261e;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  margin-bottom: 8px;
}
.blockers ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #888;
}
.chain-ok {
  font-size: 12px;
  color: #2e7d32;
  margin: 0 0 6px;
}
.chain-bad {
  font-size: 12px;
  color: #b3261e;
  margin: 0 0 6px;
}
.arrow {
  color: #999;
  flex-shrink: 0;
}
.diff h4 {
  margin: 10px 0 4px;
  font-size: 12px;
  color: #6d5c47;
  border-top: 1px dashed #e0d9cf;
  padding-top: 8px;
}
.diff .none {
  font-size: 12px;
  margin: 0;
}
.diff .list li {
  font-size: 12px;
  padding: 3px 6px;
}
</style>
