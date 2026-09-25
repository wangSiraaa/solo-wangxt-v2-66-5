import { computed, reactive } from 'vue'
import type { Table } from 'dexie'
import { db } from './db'
import { cyclePathIfAdded, layeredPositions, reachablePairs, redundantEdges, type OrderEdge } from './graph'
import { buildSample } from './sample'
import {
  captureContent,
  computeDigest,
  validateForPublish,
  verifySnapshot,
  type WorkspaceData,
} from './snapshot'
import type {
  Batch,
  Evidence,
  MetaRecord,
  Mutation,
  ProjectExport,
  Relation,
  RelationDraft,
  Retraction,
  Snapshot,
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
  /** 已发布快照链：只增不删、不可覆写 */
  snapshots: [] as Snapshot[],
  /** 当前工作区派生自哪个快照版本；null 表示独立工作区 */
  workspaceBase: null as number | null,
  /** 各快照完整性复验结果（version → 问题列表；空数组表示完好） */
  snapshotProblems: {} as Record<number, string[]>,
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

export function unitLabel(id: string): string {
  return state.units.find((u) => u.id === id)?.label ?? id
}

export function evidenceRef(id: string): string {
  return state.evidences.find((e) => e.id === id)?.ref ?? id
}

/** 最近发布的版本号；尚未发布过快照时为 0 */
export const latestVersion = computed(() =>
  state.snapshots.reduce((m, s) => Math.max(m, s.version), 0),
)

export function snapshotLabel(version: number | null): string {
  if (version === null) return '工作区'
  return `快照 v${version}`
}

/* ---------- 基础工具 ---------- */

const uid = () => crypto.randomUUID()

let toastTimer = 0
export function toast(msg: string) {
  state.toast = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (state.toast = ''), 4000)
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
  const [units, positions, relations, evidences, retractions, batches, snapshots, baseMeta] =
    await Promise.all([
      db.units.toArray(),
      db.positions.toArray(),
      db.relations.toArray(),
      db.evidences.toArray(),
      db.retractions.toArray(),
      db.batches.orderBy('at').toArray(),
      db.snapshots.orderBy('version').toArray(),
      db.meta.get('workspaceBase'),
    ])
  state.units = units.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  state.positions = Object.fromEntries(positions.map((p) => [p.unitId, p]))
  state.relations = relations.sort((a, b) => a.createdAt - b.createdAt)
  state.evidences = evidences.sort((a, b) => a.createdAt - b.createdAt)
  state.retractions = retractions.sort((a, b) => a.at - b.at)
  state.batches = batches
  state.snapshots = snapshots
  state.workspaceBase = baseMeta?.value ?? null
  // 逐条重算摘要/闭包：篡改或损坏立即在快照链中暴露
  const problems: Record<number, string[]> = {}
  await Promise.all(
    snapshots.map(async (s) => {
      const v = await verifySnapshot(s)
      if (!v.ok) problems[s.version] = v.problems
    }),
  )
  state.snapshotProblems = problems
  state.loaded = true
}

/** 当前工作区数据（发布/导出前捕获用） */
function currentWorkspaceData(): WorkspaceData {
  return {
    units: state.units.map((u) => ({ ...u })),
    positions: Object.values(state.positions).map((p) => ({ ...p })),
    relations: state.relations.map((r) => ({ ...r, evidenceIds: [...r.evidenceIds] })),
    evidences: state.evidences.map((e) => ({ ...e })),
    retractions: state.retractions.map((x) => ({
      ...x,
      snapshot: { ...x.snapshot, evidenceIds: [...x.snapshot.evidenceIds] },
    })),
  }
}

/** 供界面在发布前预检：成环冲突或悬空引用时列出全部原因 */
export function checkPublishability() {
  return validateForPublish(currentWorkspaceData())
}

/** 当前工作区的快照内容（差异审查中以“工作区”为一侧时使用） */
export function currentContent() {
  return captureContent(currentWorkspaceData())
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

/* ---------- 发布快照 / 从历史快照派生（单事务，失败不产生空版本） ---------- */

const WORKSPACE_TABLES: Table[] = [
  db.units,
  db.positions,
  db.relations,
  db.evidences,
  db.retractions,
  db.batches,
]

/**
 * 发布当前工作区为只读快照：
 * - 发布前存在成环冲突或悬空引用时阻止，并列出全部原因；
 * - 版本号在同一事务内取 max+1，保证单调，且 add 主键冲突会令事务回滚（并发发布也不覆写）；
 * - 快照写入与工作区基线更新在同一事务内，任何一步失败整体回滚，不产生空版本。
 * 返回新版本号；被阻止时返回 null。
 */
export async function publishSnapshot(note: string): Promise<number | null> {
  const data = currentWorkspaceData()
  const check = validateForPublish(data)
  if (check.blocked) {
    toast(`发布被阻止：${check.reasons[0]}（共 ${check.reasons.length} 项问题）`)
    return null
  }
  const content = captureContent(data)
  const digest = await computeDigest(content)
  const publishedAt = Date.now()
  let newVersion = 0
  await db.transaction(
    'rw',
    [db.snapshots, db.meta],
    async () => {
      // 事务内读取，杜绝并发发布造成版本号重复
      const last = await db.snapshots.orderBy('version').last()
      newVersion = (last?.version ?? 0) + 1
      const derivedFromVersion = (await db.meta.get('workspaceBase'))?.value ?? null
      const snapshot: Snapshot = {
        version: newVersion,
        note: note.trim(),
        publishedAt,
        derivedFromVersion,
        parentVersion: last?.version ?? null,
        digest,
        content,
      }
      // 主键冲突（版本号已存在）会让事务回滚，绝不覆写既有发布记录
      await db.snapshots.add(snapshot)
      const baseMeta: MetaRecord = { key: 'workspaceBase', value: newVersion, at: publishedAt }
      await db.meta.put(baseMeta)
    },
  )
  await refresh()
  toast(`已发布只读快照 v${newVersion}`)
  return newVersion
}

/**
 * 从历史快照派生新的工作区版本：
 * - 用快照内容原子替换工作区五张表（批次史一并重置，因旧批次不再适用于新工作区）；
 * - snapshots 表绝不参与写入，已有发布记录不可覆写、不可删除；
 * - 快照内容先复验摘要，被篡改/损坏则拒绝派生；
 * - 基线指向被派生的旧版本，之后再发布时新版本号接在全链尾部，形成分支关系。
 */
export async function deriveWorkspace(version: number): Promise<boolean> {
  const snapshot = await db.snapshots.get(version)
  if (!snapshot) {
    toast(`快照 v${version} 不存在`)
    return false
  }
  const verification = await verifySnapshot(snapshot)
  if (!verification.ok) {
    toast(`派生被拒绝：${verification.problems[0]}`)
    return false
  }
  const c = snapshot.content
  await db.transaction('rw', WORKSPACE_TABLES.concat(db.meta), async () => {
    await Promise.all(WORKSPACE_TABLES.map((t) => t.clear()))
    await db.units.bulkPut(c.units.map((u) => plain(u)))
    await db.positions.bulkPut(c.positions.map((p) => plain(p)))
    await db.relations.bulkPut(c.relations.map((r) => plain(r)))
    await db.evidences.bulkPut(c.evidences.map((e) => plain(e)))
    await db.retractions.bulkPut(c.retractions.map((x) => plain(x)))
    await db.meta.put({ key: 'workspaceBase', value: version, at: Date.now() } satisfies MetaRecord)
  })
  await refresh()
  state.layoutVersion++
  toast(`已从快照 v${version} 派生新工作区（发布记录链保持不变）`)
  return true
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
    [db.units, db.positions, db.relations, db.evidences, db.retractions, db.batches, db.snapshots, db.meta],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.batches.clear(),
        db.snapshots.clear(),
        db.meta.clear(),
      ])
    },
  )
  state.selectedUnitId = null
  await refresh()
  if (confirm) toast('工程已清空')
}

/** 构造导出对象（纯数据，可脱离 DOM 复用/测试） */
export function exportProjectData(): ProjectExport {
  return {
    app: 'harris-matrix-workbench',
    version: 1,
    exportedAt: new Date().toISOString(),
    units: state.units.map((u) => plain(u)),
    positions: Object.values(state.positions).map((p) => plain(p)),
    relations: state.relations.map((r) => plain(r)),
    evidences: state.evidences.map((e) => plain(e)),
    retractions: state.retractions.map((x) => plain(x)),
    partialOrder: reachablePairs(orderEdges.value),
    // 发布链随工程一起往返：导入后逐条重算摘要，篡改即被识别
    snapshots: state.snapshots.map((s) => plain(s)),
    workspaceBase: state.workspaceBase,
  }
}

export function exportProject() {
  const data = exportProjectData()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `harris-matrix-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  toast(`已导出（偏序闭包 ${data.partialOrder.length} 个可达对，快照 ${data.snapshots?.length ?? 0} 个）`)
}

export interface ImportResult {
  ok: boolean
  message: string
}

/**
 * 从导出对象导入（纯数据）。先复验文件内全部快照摘要，任一不符则整次拒绝、
 * 不写入任何表；通过后以单事务清空并替换全部工程数据。
 */
export async function importProjectData(data: ProjectExport): Promise<ImportResult> {
  if (data?.app !== 'harris-matrix-workbench' || !Array.isArray(data.units) || !Array.isArray(data.relations)) {
    return { ok: false, message: '导入失败：文件格式不符' }
  }
  // 导入前在事务外先复验文件内快照摘要：篡改/损坏的快照不允许进入发布链
  const importedSnapshots = data.snapshots ?? []
  const tampered: string[] = []
  for (const s of importedSnapshots) {
    try {
      const v = await verifySnapshot(s)
      if (!v.ok) tampered.push(...v.problems)
    } catch {
      tampered.push(`快照 v${s?.version ?? '?'} 结构损坏，无法复验摘要`)
    }
  }
  if (tampered.length > 0) {
    return {
      ok: false,
      message: `导入被拒绝：工程文件中有 ${tampered.length} 个快照摘要校验失败，疑似被篡改或损坏`,
    }
  }
  await db.transaction(
    'rw',
    [db.units, db.positions, db.relations, db.evidences, db.retractions, db.batches, db.snapshots, db.meta],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.batches.clear(),
        db.snapshots.clear(),
        db.meta.clear(),
      ])
      await db.units.bulkPut(data.units)
      await db.positions.bulkPut(data.positions ?? [])
      await db.relations.bulkPut(data.relations)
      await db.evidences.bulkPut(data.evidences ?? [])
      await db.retractions.bulkPut(data.retractions ?? [])
      await db.snapshots.bulkAdd(importedSnapshots)
      if (data.workspaceBase !== undefined) {
        await db.meta.put({ key: 'workspaceBase', value: data.workspaceBase ?? null, at: null } satisfies MetaRecord)
      }
    },
  )
  await refresh()
  state.layoutVersion++
  // 偏序一致性校验：重算可达对并与导出快照比对
  const expected = [...(data.partialOrder ?? [])].sort()
  const actual = reachablePairs(orderEdges.value)
  const same = JSON.stringify(expected) === JSON.stringify(actual)
  const snapNote = importedSnapshots.length > 0 ? `；已复验 ${importedSnapshots.length} 个快照摘要` : ''
  return {
    ok: same,
    message: same
      ? `导入完成，偏序校验一致（${actual.length} 个可达对）${snapNote}`
      : '导入完成，但偏序与导出时不一致，请检查数据',
  }
}

export async function importProject(file: File) {
  let data: ProjectExport
  try {
    data = JSON.parse(await file.text())
  } catch {
    toast('导入失败：不是有效的 JSON 文件')
    return
  }
  if (!window.confirm('导入将替换当前工程（含已发布快照，不可撤销），继续？')) return
  const result = await importProjectData(data)
  toast(result.message)
}
