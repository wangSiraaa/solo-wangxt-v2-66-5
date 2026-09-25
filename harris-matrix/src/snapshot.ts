import { buildGraph, findPath, reachablePairs, type OrderEdge } from './graph'
import type {
  Evidence,
  Relation,
  Retraction,
  Snapshot,
  SnapshotContent,
  StratUnit,
  UnitPosition,
} from './types'

/* ============================== 内容捕获 ============================== */

export interface WorkspaceData {
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
}

/** 活跃“早于”边：冲突状态的边同样参与闭包（闭包能算出全部可达对），成环另由校验环节报告 */
export function activeEarlierEdges(relations: Relation[]): OrderEdge[] {
  return relations
    .filter((r) => r.status === 'active' && r.kind === 'earlier')
    .map((r) => ({ id: r.id, from: r.from, to: r.to }))
}

/** 把当前工作区捕获为不可变快照内容（深拷贝 + 冻结偏序闭包） */
export function captureContent(data: WorkspaceData): SnapshotContent {
  const relations = data.relations.map((r) => ({ ...r, evidenceIds: [...r.evidenceIds] }))
  return {
    app: 'harris-matrix-workbench',
    contentVersion: 1,
    units: data.units.map((u) => ({ ...u })),
    positions: data.positions.map((p) => ({ ...p })),
    relations,
    evidences: data.evidences.map((e) => ({ ...e })),
    retractions: data.retractions.map((x) => ({
      ...x,
      snapshot: { ...x.snapshot, evidenceIds: [...x.snapshot.evidenceIds] },
    })),
    partialOrder: reachablePairs(activeEarlierEdges(relations)),
  }
}

/* ============================== 摘要（digest） ============================== */

/**
 * 规范化 JSON：对象键递归排序、数组按稳定键排序，
 * 保证同一内容无论来源（实时捕获 / JSON 往返）序列化结果字节一致。
 */
export function canonicalJSON(content: SnapshotContent): string {
  const sortArrays: Record<string, (a: unknown, b: unknown) => number> = {
    units: byKey('id'),
    positions: byKey('unitId'),
    relations: byKey('id'),
    evidences: byKey('id'),
    retractions: byKey('id'),
    partialOrder: (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
  }
  const normalize = (value: unknown, arrayKey?: string): unknown => {
    if (Array.isArray(value)) {
      const arr = value.map((v) => normalize(v))
      if (arrayKey && sortArrays[arrayKey]) arr.sort(sortArrays[arrayKey])
      return arr
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        out[k] = normalize((value as Record<string, unknown>)[k], k)
      }
      return out
    }
    return value
  }
  return JSON.stringify(normalize(content))
}

function byKey(key: string): (a: unknown, b: unknown) => number {
  return (a, b) => {
    const x = String((a as Record<string, unknown>)[key])
    const y = String((b as Record<string, unknown>)[key])
    return x < y ? -1 : x > y ? 1 : 0
  }
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 内容指纹：sha256(规范化 JSON)，浏览器与 Node 20 均可用全局 WebCrypto */
export async function computeDigest(content: SnapshotContent): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJSON(content))
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', bytes))
}

/* ============================== 发布前校验：成环 / 悬空 ============================== */

export interface CycleConflict {
  relationId: string
  from: string
  to: string
  path: string[]
}

/**
 * 成环冲突检测：按记录时间逐条将活跃“早于”边加入 DAG 骨架，
 * 加入后若其终点已能回到起点则构成环（与新增关系时的判定口径一致），
 * 返回每条闭合边及完整环路径，用于发布前逐条列原因。
 */
export function findCycleConflicts(relations: Relation[]): CycleConflict[] {
  const edges = relations
    .filter((r) => r.status === 'active' && r.kind === 'earlier')
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const skeleton: OrderEdge[] = []
  const conflicts: CycleConflict[] = []
  for (const e of edges) {
    if (e.from === e.to) {
      conflicts.push({ relationId: e.id, from: e.from, to: e.to, path: [e.from, e.from] })
      continue
    }
    const g = buildGraph(skeleton)
    const back = g.hasNode(e.to) && g.hasNode(e.from) ? findPath(g, e.to, e.from) : null
    if (back) {
      conflicts.push({ relationId: e.id, from: e.from, to: e.to, path: [e.from, ...back] })
    } else {
      skeleton.push({ id: e.id, from: e.from, to: e.to })
    }
  }
  return conflicts
}

/** 悬空引用检测：位置、关系、撤销记录中引用了不存在的层位/证据/关系 */
export function findDangling(data: WorkspaceData): string[] {
  const unitIds = new Set(data.units.map((u) => u.id))
  const evidenceIds = new Set(data.evidences.map((e) => e.id))
  const relationIds = new Set(data.relations.map((r) => r.id))
  const reasons: string[] = []

  for (const p of data.positions) {
    if (!unitIds.has(p.unitId)) reasons.push(`位置引用了不存在的层位 ${p.unitId}`)
  }
  for (const r of data.relations) {
    if (!unitIds.has(r.from)) reasons.push(`关系 ${r.id}（${r.from}→${r.to}）的起点层位 ${r.from} 不存在`)
    if (!unitIds.has(r.to)) reasons.push(`关系 ${r.id}（${r.from}→${r.to}）的终点层位 ${r.to} 不存在`)
    for (const eid of r.evidenceIds) {
      if (!evidenceIds.has(eid)) reasons.push(`关系 ${r.id}（${r.from}→${r.to}）引用了不存在的证据 ${eid}`)
    }
  }
  for (const x of data.retractions) {
    if (!relationIds.has(x.relationId)) {
      reasons.push(`撤销记录 ${x.id} 指向不存在的关系 ${x.relationId}`)
    }
    const s = x.snapshot
    if (!unitIds.has(s.from)) reasons.push(`撤销记录 ${x.id} 的快照起点层位 ${s.from} 不存在`)
    if (!unitIds.has(s.to)) reasons.push(`撤销记录 ${x.id} 的快照终点层位 ${s.to} 不存在`)
    for (const eid of s.evidenceIds) {
      if (!evidenceIds.has(eid)) reasons.push(`撤销记录 ${x.id} 引用了不存在的证据 ${eid}`)
    }
  }
  return reasons
}

export interface PublishBlock {
  blocked: boolean
  cycleConflicts: CycleConflict[]
  dangling: string[]
  reasons: string[]
}

/** 发布前完整校验：存在成环冲突或悬空引用时必须阻止 */
export function validateForPublish(data: WorkspaceData): PublishBlock {
  const cycleConflicts = findCycleConflicts(data.relations)
  const dangling = findDangling(data)
  const reasons: string[] = []
  for (const c of cycleConflicts) reasons.push(`成环冲突：${c.path.join(' → ')}（闭合关系 ${c.relationId}：${c.from}→${c.to}）`)
  for (const d of dangling) reasons.push(`悬空引用：${d}`)
  return { blocked: reasons.length > 0, cycleConflicts, dangling, reasons }
}

/* ============================== 完整性校验 ============================== */

export interface SnapshotVerification {
  version: number
  /** 摘要与重算结果一致 */
  digestOk: boolean
  /** 冻结的偏序闭包与按关系重算结果一致 */
  closureOk: boolean
  ok: boolean
  problems: string[]
}

/** 复验快照：重算内容摘要与偏序闭包，任何一项不符即判为被篡改/损坏 */
export async function verifySnapshot(snapshot: Snapshot): Promise<SnapshotVerification> {
  const problems: string[] = []
  const digestOk = (await computeDigest(snapshot.content)) === snapshot.digest
  if (!digestOk) problems.push(`v${snapshot.version} 内容摘要不匹配：内容已被篡改或文件损坏`)
  const closureOk =
    JSON.stringify([...snapshot.content.partialOrder].sort()) ===
    JSON.stringify(reachablePairs(activeEarlierEdges(snapshot.content.relations)))
  if (!closureOk) problems.push(`v${snapshot.version} 偏序闭包与关系重算结果不一致`)
  return { version: snapshot.version, digestOk, closureOk, ok: digestOk && closureOk, problems }
}

/* ============================== 差异审查 ============================== */

export type ChangeKind = 'added' | 'removed' | 'modified'

export interface EntityChange<T> {
  kind: ChangeKind
  id: string
  before: T | null
  after: T | null
}

export interface PairChange {
  kind: 'added' | 'removed'
  pair: string
}

export interface SnapshotDiff {
  units: EntityChange<StratUnit>[]
  positions: EntityChange<UnitPosition>[]
  evidences: EntityChange<Evidence>[]
  retractions: EntityChange<Retraction>[]
  /** 直接关系变化：按关系 id 对齐的增/删/改（含 status、conflict 等全部字段） */
  relations: EntityChange<Relation>[]
  /** 仅由闭包推导造成的语义变化：不在“直接边增删”集合中的可达对增删 */
  semanticClosure: PairChange[]
  /** 直接边（活跃 earlier 对）的增删；其中不伴随闭包变化的属于冗余边改动，无语义影响 */
  directEdgePairs: PairChange[]
  /** 直接边改动但偏序闭包未变（传递冗余边） */
  directPairsWithoutSemanticEffect: PairChange[]
  isEmpty: boolean
}

function diffEntities<T extends { id?: string; unitId?: string }>(
  beforeArr: T[],
  afterArr: T[],
  keyOf: (t: T) => string,
): EntityChange<T>[] {
  const out: EntityChange<T>[] = []
  const before = new Map(beforeArr.map((x) => [keyOf(x), x]))
  const after = new Map(afterArr.map((x) => [keyOf(x), x]))
  for (const [id, b] of before) {
    const a = after.get(id)
    if (!a) out.push({ kind: 'removed', id, before: b, after: null })
    else if (JSON.stringify(b) !== JSON.stringify(a)) out.push({ kind: 'modified', id, before: b, after: a })
  }
  for (const [id, a] of after) {
    if (!before.has(id)) out.push({ kind: 'added', id, before: null, after: a })
  }
  return out.sort((x, y) => x.id.localeCompare(y.id) || x.kind.localeCompare(y.kind))
}

/** 活跃 earlier 直接边对集合（同对去重，与图边口径一致） */
function directPairSet(content: SnapshotContent): Set<string> {
  const set = new Set<string>()
  for (const r of content.relations) {
    if (r.status === 'active' && r.kind === 'earlier') set.add(`${r.from}→${r.to}`)
  }
  return set
}

function pairChanges(beforeSet: Set<string>, afterSet: Set<string>): PairChange[] {
  const out: PairChange[] = []
  for (const p of beforeSet) if (!afterSet.has(p)) out.push({ kind: 'removed', pair: p })
  for (const p of afterSet) if (!beforeSet.has(p)) out.push({ kind: 'added', pair: p })
  return out.sort((a, b) => a.pair.localeCompare(b.pair))
}

/**
 * 比较两份快照内容（A→B）。差异分三类：
 *  1. 实体变化：层位 / 位置 / 证据 / 撤销记录的增删改；
 *  2. 直接关系变化：关系记录本身的增删改（含撤回、冲突标记变化）；
 *  3. 语义变化：偏序闭包可达对中，排除直接边增删后，仅由传递闭包推导造成的增删。
 */
export function diffContents(before: SnapshotContent, after: SnapshotContent): SnapshotDiff {
  const units = diffEntities(before.units, after.units, (u) => u.id)
  const positions = diffEntities(before.positions, after.positions, (p) => p.unitId)
  const evidences = diffEntities(before.evidences, after.evidences, (e) => e.id)
  const retractions = diffEntities(before.retractions, after.retractions, (x) => x.id)
  const relations = diffEntities(before.relations, after.relations, (r) => r.id)

  const beforeDirect = directPairSet(before)
  const afterDirect = directPairSet(after)
  const directEdgePairs = pairChanges(beforeDirect, afterDirect)
  const directDelta = new Set(directEdgePairs.map((c) => c.pair))

  const beforeClosure = new Set(before.partialOrder)
  const afterClosure = new Set(after.partialOrder)
  const closureDelta = pairChanges(beforeClosure, afterClosure)
  const semanticClosure = closureDelta.filter((c) => !directDelta.has(c.pair))
  const closureChanged = new Set(closureDelta.map((c) => c.pair))
  const directPairsWithoutSemanticEffect = directEdgePairs.filter((c) => !closureChanged.has(c.pair))

  const isEmpty =
    units.length === 0 &&
    positions.length === 0 &&
    evidences.length === 0 &&
    retractions.length === 0 &&
    relations.length === 0 &&
    semanticClosure.length === 0 &&
    directEdgePairs.length === 0

  return {
    units,
    positions,
    evidences,
    retractions,
    relations,
    semanticClosure,
    directEdgePairs,
    directPairsWithoutSemanticEffect,
    isEmpty,
  }
}
