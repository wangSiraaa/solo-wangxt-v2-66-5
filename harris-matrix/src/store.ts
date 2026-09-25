import { computed, reactive } from 'vue'
import { db } from './db'
import { cyclePathIfAdded, layeredPositions, reachablePairs, redundantEdges, type OrderEdge } from './graph'
import { buildSample } from './sample'
import {
  GENESIS_DIGEST,
  buildSnapshotContent,
  computeDigest,
  contentOf,
  diffContents,
  findPublishBlockers,
  verifySnapshotChain,
  verifySnapshotContent,
} from './snapshot'
import type {
  Batch,
  Evidence,
  Mutation,
  ProjectExport,
  PublishBlocker,
  Relation,
  RelationDraft,
  Retraction,
  Snapshot,
  SnapshotContent,
  SnapshotDiff,
  StratUnit,
  TableName,
  UnitPosition,
  UnitType,
} from './types'

export const state = reactive({
  loaded: false,
  units: [] as StratUnit[],
  positions: {} as Record<string, UnitPosition>,
  relations: [] as Relation[],
  evidences: [] as Evidence[],
  retractions: [] as Retraction[],
  batches: [] as Batch[],
  snapshots: [] as Snapshot[],
  /** 发布链完整性校验发现的问题（空数组 = 校验通过） */
  snapshotIssues: [] as string[],
  viewMode: 'raw' as 'raw' | 'simplified',
  selectedUnitId: null as string | null,
  /** 待确认的成环关系：记录员可选择保留为矛盾记录或取消 */
  pendingCycle: null as { draft: RelationDraft; path: string[] } | null,
  toast: '',
  /** 自增以通知画布重排（身份与位置分离，位置变化不触发数据刷新） */
  layoutVersion: 0,
})

/* ---------- 派生数据 ---------- */

export const activeRelations = computed(() => state.relations.filter((r) => r.status === 'active'))

/** 仅“早于”关系进入有向图；同期关联被明确排除 */
export const orderEdges = computed<OrderEdge[]>(() =>
  activeRelations.value.filter((r) => r.kind === 'earlier').map((r) => ({ id: r.id, from: r.from, to: r.to })),
)

/** 简化视图要隐藏的传递冗余边（只隐藏，不删除） */
export const redundantIds = computed(() => redundantEdges(orderEdges.value))

export const lastBatch = computed(() => {
  for (let i = state.batches.length - 1; i >= 0; i--) {
    if (!state.batches[i].undone) return state.batches[i]
  }
  return null
})

/** 当前工作区的发布阻断项（成环冲突 / 悬空引用），面板实时展示，发布时复核 */
export const publishBlockers = computed<PublishBlocker[]>(() =>
  findPublishBlockers(
    state.units,
    Object.values(state.positions),
    state.relations,
    state.evidences,
    state.retractions,
    unitLabel,
  ),
)

export function unitLabel(id: string): string {
  return state.units.find((u) => u.id === id)?.label ?? id
}

export function evidenceRef(id: string): string {
  return state.evidences.find((e) => e.id === id)?.ref ?? id
}

/* ---------- 基础工具 ---------- */

const uid = () => crypto.randomUUID()

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(msg: string) {
  state.toast = msg
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (state.toast = ''), 4000)
}

function tableOf(name: TableName) {
  return { units: db.units, positions: db.positions, relations: db.relations, evidences: db.evidences, retractions: db.retractions }[name]
}

/** 写入 IndexedDB 前去除 Vue 响应式代理（structuredClone 无法克隆 Proxy） */
function plain<T>(v: T): T {
  return v == null ? v : JSON.parse(JSON.stringify(v))
}

async function applyForward(m: Mutation) {
  const t = tableOf(m.table)
  if (m.after == null) await t.delete(m.key)
  else await t.put(plain(m.after) as never)
}

async function applyInverse(m: Mutation) {
  const t = tableOf(m.table)
  if (m.before == null) await t.delete(m.key)
  else await t.put(plain(m.before) as never)
}

export async function refresh() {
  const [units, positions, relations, evidences, retractions, batches, snapshots] = await Promise.all([
    db.units.toArray(),
    db.positions.toArray(),
    db.relations.toArray(),
    db.evidences.toArray(),
    db.retractions.toArray(),
    db.batches.orderBy('at').toArray(),
    db.snapshots.orderBy('version').toArray(),
  ])
  state.units = units.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  state.positions = Object.fromEntries(positions.map((p) => [p.unitId, p]))
  state.relations = relations.sort((a, b) => a.createdAt - b.createdAt)
  state.evidences = evidences.sort((a, b) => a.createdAt - b.createdAt)
  state.retractions = retractions.sort((a, b) => a.at - b.at)
  state.batches = batches
  state.snapshots = snapshots
  // 每次刷新都重验发布链：版本连续、摘要衔接、内容未被篡改
  state.snapshotIssues = verifySnapshotChain(snapshots)
  state.loaded = true
}

/** 以批次执行一组变更：全部正向应用后登记批次，供整体撤销 */
async function runBatch(label: string, mutations: Mutation[]) {
  if (mutations.length === 0) return
  for (const m of mutations) await applyForward(m)
  const batch: Batch = { id: uid(), label, at: Date.now(), undone: false, mutations }
  await db.batches.put(plain(batch))
  await refresh()
}

/** 撤销最近一个未撤销的批次：关系与证据引用随逆向变更一起恢复 */
export async function undo() {
  const batch = [...state.batches].reverse().find((b) => !b.undone)
  if (!batch) {
    toast('没有可撤销的操作')
    return
  }
  for (const m of [...batch.mutations].reverse()) await applyInverse(m)
  await db.batches.update(batch.id, { undone: true })
  await refresh()
  toast(`已撤销：${batch.label}`)
}

/* ---------- 发布快照与差异审查 ---------- */

export interface PublishResult {
  ok: boolean
  blockers: PublishBlocker[]
  snapshot?: Snapshot
}

/**
 * 发布只读快照：封存当前层位、位置、全部关系与冲突状态。
 * 存在成环冲突或悬空引用时拒绝发布并列出全部原因；
 * 版本号在事务内取最大版本 +1（version 带唯一索引），摘要链式衔接上一版；
 * 整个发布在一次 IndexedDB 事务中完成，失败时不产生任何版本记录。
 */
export async function publishSnapshot(note: string): Promise<PublishResult> {
  const blockers = findPublishBlockers(
    state.units,
    Object.values(state.positions),
    state.relations,
    state.evidences,
    state.retractions,
    unitLabel,
  )
  if (blockers.length > 0) {
    toast(`发布被阻止：${blockers.length} 项问题需先处理`)
    return { ok: false, blockers }
  }
  const content = buildSnapshotContent({
    units: state.units,
    positions: Object.values(state.positions),
    relations: state.relations,
    evidences: state.evidences,
    retractions: state.retractions,
  })
  try {
    const snapshot = await db.transaction('rw', db.snapshots, async () => {
      const last = await db.snapshots.orderBy('version').last()
      const version = (last?.version ?? 0) + 1
      const prevDigest = last?.digest ?? GENESIS_DIGEST
      const snap: Snapshot = {
        id: uid(),
        version,
        note: note.trim(),
        createdAt: Date.now(),
        prevDigest,
        digest: computeDigest(prevDigest, content),
        ...content,
      }
      // add 而非 put：同版本号冲突即整体失败，绝不覆写已有发布记录
      await db.snapshots.add(snap)
      return snap
    })
    await refresh()
    toast(`已发布只读快照 v${snapshot.version}（摘要 ${snapshot.digest.slice(0, 12)}…）`)
    return { ok: true, blockers: [], snapshot }
  } catch (err) {
    // 事务已回滚：不产生空版本或半截版本
    console.error('publish failed:', err)
    toast('发布失败：未产生任何版本')
    return { ok: false, blockers: [{ kind: 'dangling', message: `存储事务失败：${String(err)}` }] }
  }
}

/**
 * 从历史快照派生新的工作区版本：五张工作区表整体替换为快照内容，
 * 与批次登记在同一个 IndexedDB 事务中完成（可整体撤销）；
 * 只读快照表不被触碰——绝不覆写或删除已有发布记录。
 * 快照校验未通过（疑似篡改）时拒绝派生。
 */
export async function deriveFromSnapshot(id: string): Promise<boolean> {
  const snap = state.snapshots.find((s) => s.id === id)
  if (!snap) {
    toast('快照不存在')
    return false
  }
  const issues = verifySnapshotContent(snap)
  if (issues.length > 0) {
    toast(`快照 v${snap.version} 校验未通过，已拒绝派生`)
    return false
  }

  // 整批变更：逐表计算 before/after，使派生可整体撤销
  const replaceRows = <T>(
    table: TableName,
    keyOf: (row: T) => string,
    currentRows: T[],
    nextRows: T[],
  ): Mutation[] => {
    const cur = new Map(currentRows.map((r) => [keyOf(r), r]))
    const nxt = new Map(nextRows.map((r) => [keyOf(r), r]))
    const ms: Mutation[] = []
    for (const [k, row] of nxt) ms.push({ table, key: k, before: cur.get(k) ?? null, after: row })
    for (const [k, row] of cur) if (!nxt.has(k)) ms.push({ table, key: k, before: row, after: null })
    return ms
  }
  const content = contentOf(snap)
  const mutations: Mutation[] = [
    ...replaceRows('units', (u: StratUnit) => u.id, state.units, content.units),
    ...replaceRows('positions', (p: UnitPosition) => p.unitId, Object.values(state.positions), content.positions),
    ...replaceRows('relations', (r: Relation) => r.id, state.relations, content.relations),
    ...replaceRows('evidences', (e: Evidence) => e.id, state.evidences, content.evidences),
    ...replaceRows('retractions', (x: Retraction) => x.id, state.retractions, content.retractions),
  ]
  const batch: Batch = {
    id: uid(),
    label: `从快照 v${snap.version} 派生工作区`,
    at: Date.now(),
    undone: false,
    mutations,
  }
  try {
    await db.transaction('rw', [db.units, db.positions, db.relations, db.evidences, db.retractions, db.batches], async () => {
      for (const m of mutations) await applyForward(m)
      await db.batches.add(plain(batch))
    })
  } catch (err) {
    // 事务回滚：工作区保持原样，不留空版本
    console.error('derive failed:', err)
    toast('派生失败：工作区未被改动')
    return false
  }
  state.selectedUnitId = null
  await refresh()
  state.layoutVersion++
  toast(`已从快照 v${snap.version} 派生新工作区（可撤销；已发布快照不受影响）`)
  return true
}

/** 差异审查对象：当前工作区，或某个已发布快照 */
export type CompareTarget = 'workspace' | string

export function contentOfTarget(target: CompareTarget): SnapshotContent | null {
  if (target === 'workspace') {
    return buildSnapshotContent({
      units: state.units,
      positions: Object.values(state.positions),
      relations: state.relations,
      evidences: state.evidences,
      retractions: state.retractions,
    })
  }
  const snap = state.snapshots.find((s) => s.id === target)
  return snap ? contentOf(snap) : null
}

/** 比较任意两版（快照 ↔ 快照、快照 ↔ 工作区），差异区分实体 / 直接关系 / 闭包语义三类 */
export function compareTargets(a: CompareTarget, b: CompareTarget): SnapshotDiff | null {
  const ca = contentOfTarget(a)
  const cb = contentOfTarget(b)
  if (!ca || !cb) return null
  return diffContents(ca, cb)
}

/* ---------- 层位 ---------- */

export async function addUnit(label: string, type: UnitType, note: string) {
  label = label.trim()
  if (!label) return
  if (state.units.some((u) => u.label === label)) {
    toast(`层位 ${label} 已存在`)
    return
  }
  const unit: StratUnit = { id: uid(), label, type, note: note.trim(), createdAt: Date.now() }
  await runBatch(`新增层位 ${label}`, [{ table: 'units', key: unit.id, before: null, after: unit }])
  toast(`已新增层位 ${label}`)
}

export async function deleteUnit(id: string) {
  const unit = state.units.find((u) => u.id === id)
  if (!unit) return
  const mutations: Mutation[] = [{ table: 'units', key: id, before: unit, after: null }]
  const pos = state.positions[id]
  if (pos) mutations.push({ table: 'positions', key: id, before: pos, after: null })
  // 连带删除涉及该层位的关系及其撤销记录（全部记入批次，可整体撤销）
  for (const r of state.relations.filter((r) => r.from === id || r.to === id)) {
    mutations.push({ table: 'relations', key: r.id, before: r, after: null })
    for (const x of state.retractions.filter((x) => x.relationId === r.id)) {
      mutations.push({ table: 'retractions', key: x.id, before: x, after: null })
    }
  }
  await runBatch(`删除层位 ${unit.label}（连带 ${mutations.length - (pos ? 2 : 1)} 条关系）`, mutations)
  if (state.selectedUnitId === id) state.selectedUnitId = null
  toast(`已删除层位 ${unit.label}`)
}

/* ---------- 证据 ---------- */

export async function addEvidence(ref: string, text: string) {
  ref = ref.trim()
  if (!ref) return
  const ev: Evidence = { id: uid(), ref, text: text.trim(), createdAt: Date.now() }
  await runBatch(`登记证据 ${ref}`, [{ table: 'evidences', key: ev.id, before: null, after: ev }])
  toast(`已登记证据 ${ref}`)
}

/* ---------- 关系 ---------- */

function makeRelation(draft: RelationDraft, conflict: boolean): Relation {
  return {
    id: uid(),
    from: draft.from,
    to: draft.to,
    kind: draft.kind,
    source: draft.source,
    status: 'active',
    conflict,
    evidenceIds: [...draft.evidenceIds],
    note: draft.note.trim(),
    createdAt: Date.now(),
  }
}

function describe(draft: RelationDraft): string {
  return draft.kind === 'earlier'
    ? `${unitLabel(draft.from)} 早于 ${unitLabel(draft.to)}`
    : `${unitLabel(draft.from)} 与 ${unitLabel(draft.to)} 同期`
}

/**
 * 新增关系。先后关系先做有向成环检测：若成环则挂起并给出完整环路径，
 * 由记录员决定保留为矛盾记录或取消。同期关联不进入有向图，直接保存。
 */
export async function addRelation(draft: RelationDraft, allowConflict = false) {
  if (!draft.from || !draft.to) return
  if (draft.kind === 'earlier' && draft.from === draft.to) {
    toast('层位不能早于其自身')
    return
  }
  const dup = activeRelations.value.some(
    (r) => r.from === draft.from && r.to === draft.to && r.kind === draft.kind,
  )
  if (dup) {
    toast('相同的关系已存在')
    return
  }

  if (draft.kind === 'contemporary') {
    // 同期关联：只存档，不作为有向边参与偏序
    const relation = makeRelation(draft, false)
    await runBatch(`新增同期关联：${describe(draft)}`, [
      { table: 'relations', key: relation.id, before: null, after: relation },
    ])
    toast('已保存同期关联（不进入有向图）')
    return
  }

  const cycle = cyclePathIfAdded(orderEdges.value, draft.from, draft.to)
  if (cycle && !allowConflict) {
    state.pendingCycle = { draft: { ...draft }, path: cycle }
    return
  }
  const relation = makeRelation(draft, cycle !== null)
  await runBatch(
    cycle ? `新增矛盾记录：${describe(draft)}` : `新增先后关系：${describe(draft)}`,
    [{ table: 'relations', key: relation.id, before: null, after: relation }],
  )
  toast(cycle ? '已保存为矛盾记录（成环路径见画布红边）' : '已添加先后关系')
}

/** 确认保留成环关系为矛盾记录 */
export async function confirmCycle() {
  const pending = state.pendingCycle
  if (!pending) return
  state.pendingCycle = null
  await addRelation(pending.draft, true)
}

export function cancelCycle() {
  state.pendingCycle = null
}

/** 撤回判断：关系标记为 retracted，快照与理由单独存入 retractions 表 */
export async function retractRelation(id: string, reason: string) {
  const rel = state.relations.find((r) => r.id === id)
  if (!rel || rel.status !== 'active') return
  const retraction: Retraction = {
    id: uid(),
    relationId: id,
    snapshot: { ...rel },
    reason: reason.trim() || '（未填写理由）',
    at: Date.now(),
  }
  await runBatch(`撤回判断：${unitLabel(rel.from)} → ${unitLabel(rel.to)}`, [
    { table: 'relations', key: id, before: rel, after: { ...rel, status: 'retracted' as const } },
    { table: 'retractions', key: retraction.id, before: null, after: retraction },
  ])
  toast('已撤回，判断与理由已单独存档')
}

/* ---------- 画布位置（与地层身份分离，不进入撤销批次） ---------- */

export async function savePosition(unitId: string, x: number, y: number) {
  const pos: UnitPosition = { unitId, x, y }
  await db.positions.put(pos)
  state.positions = { ...state.positions, [unitId]: pos }
}

/** 按最长路径分层自动排布（忽略成环边） */
export async function autoLayout() {
  const auto = layeredPositions(
    state.units.map((u) => u.id),
    orderEdges.value,
  )
  for (const [id, p] of auto) await db.positions.put({ unitId: id, x: p.x, y: p.y })
  await refresh()
  state.layoutVersion++
  toast('已按地层早晚自动分层排布')
}

/* ---------- 示例 / 清空 / 导出 / 导入 ---------- */

export async function loadSample() {
  if (state.units.length > 0 && !window.confirm('载入示例将先清空当前工程（不可撤销），继续？')) return
  await clearAll(false)
  const now = Date.now()
  const sample = buildSample(now)
  const positions = layeredPositions(
    sample.units.map((u) => u.id),
    sample.relations.filter((r) => r.kind === 'earlier' && r.status === 'active'),
  )
  const mutations: Mutation[] = []
  for (const u of sample.units) mutations.push({ table: 'units', key: u.id, before: null, after: u })
  for (const e of sample.evidences) mutations.push({ table: 'evidences', key: e.id, before: null, after: e })
  for (const r of sample.relations) mutations.push({ table: 'relations', key: r.id, before: null, after: r })
  for (const x of sample.retractions) mutations.push({ table: 'retractions', key: x.id, before: null, after: x })
  for (const u of sample.units) {
    const p = positions.get(u.id)
    if (p) mutations.push({ table: 'positions', key: u.id, before: null, after: { unitId: u.id, ...p } })
  }
  await runBatch('载入示例工程', mutations)
  state.layoutVersion++
  toast('示例工程已载入（含切割事件、孤立层位、矛盾记录与已撤销判断）')
}

export async function clearAll(confirm = true) {
  if (confirm && !window.confirm('清空全部工程数据（含已发布快照）？此操作不可撤销。')) return
  await db.transaction(
    'rw',
    [db.units, db.positions, db.relations, db.evidences, db.retractions, db.batches, db.snapshots],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.batches.clear(),
        db.snapshots.clear(),
      ])
    },
  )
  state.selectedUnitId = null
  await refresh()
  if (confirm) toast('工程已清空')
}

export function buildProjectExport(): ProjectExport {
  return {
    app: 'harris-matrix-workbench',
    version: 1,
    exportedAt: new Date().toISOString(),
    units: state.units,
    positions: Object.values(state.positions),
    relations: state.relations,
    evidences: state.evidences,
    retractions: state.retractions,
    snapshots: state.snapshots,
    partialOrder: reachablePairs(orderEdges.value),
  }
}

export function exportProject() {
  const data = buildProjectExport()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `harris-matrix-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  toast(`已导出（偏序闭包 ${data.partialOrder.length} 个可达对，快照 ${data.snapshots?.length ?? 0} 版）`)
}

/** 导入已解析的工程数据：整体替换（含已发布快照），返回偏序校验结果 */
export async function importProjectData(data: ProjectExport): Promise<{ partialOrderOk: boolean }> {
  await db.transaction(
    'rw',
    [db.units, db.positions, db.relations, db.evidences, db.retractions, db.batches, db.snapshots],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.batches.clear(),
        db.snapshots.clear(),
      ])
      await db.units.bulkPut(data.units)
      await db.positions.bulkPut(data.positions ?? [])
      await db.relations.bulkPut(data.relations)
      await db.evidences.bulkPut(data.evidences ?? [])
      await db.retractions.bulkPut(data.retractions ?? [])
      await db.snapshots.bulkPut(data.snapshots ?? [])
    },
  )
  await refresh()
  state.layoutVersion++
  // 偏序一致性校验：重算可达对并与导出快照比对
  const expected = [...(data.partialOrder ?? [])].sort()
  const actual = reachablePairs(orderEdges.value)
  return { partialOrderOk: JSON.stringify(expected) === JSON.stringify(actual) }
}

export async function importProject(file: File) {
  let data: ProjectExport
  try {
    data = JSON.parse(await file.text())
  } catch {
    toast('导入失败：不是有效的 JSON 文件')
    return
  }
  if (data?.app !== 'harris-matrix-workbench' || !Array.isArray(data.units) || !Array.isArray(data.relations)) {
    toast('导入失败：文件格式不符')
    return
  }
  if (!window.confirm('导入将替换当前工程（不可撤销），继续？')) return
  const { partialOrderOk } = await importProjectData(data)
  const snapCount = data.snapshots?.length ?? 0
  let msg = partialOrderOk
    ? `导入完成，偏序校验一致（${reachablePairs(orderEdges.value).length} 个可达对，快照 ${snapCount} 版）`
    : '导入完成，但偏序与导出时不一致，请检查数据'
  // 快照链在 refresh 中已重验：JSON 往返后摘要与版本关系应保持一致，篡改会在此暴露
  if (state.snapshotIssues.length > 0) msg += `；注意：快照链校验发现 ${state.snapshotIssues.length} 项问题`
  toast(msg)
}
