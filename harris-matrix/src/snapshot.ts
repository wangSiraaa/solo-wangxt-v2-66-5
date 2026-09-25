import { buildGraph, findPath, reachablePairs, type OrderEdge } from './graph'
import { sha256Hex, stableStringify } from './digest'
import type {
  Evidence,
  PublishBlocker,
  Relation,
  Retraction,
  Snapshot,
  SnapshotContent,
  SnapshotDiff,
  StratUnit,
  UnitPosition,
} from './types'

/** 首个快照的前置摘要（创世值） */
export const GENESIS_DIGEST = ''

/** 活跃“早于”关系的有向边（同期关联与已撤销判断绝不进入） */
function activeEarlierEdges(relations: Relation[]): OrderEdge[] {
  return relations
    .filter((r) => r.status === 'active' && r.kind === 'earlier')
    .map((r) => ({ id: r.id, from: r.from, to: r.to }))
}

/** 某版内容的偏序闭包：活跃“早于”关系的全部可达对（排序后） */
export function snapshotClosure(relations: Relation[]): string[] {
  return reachablePairs(activeEarlierEdges(relations))
}

/** 从工作区各表构建快照内容：深拷贝为纯数据，并附上发布时刻的偏序闭包 */
export function buildSnapshotContent(parts: {
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
}): SnapshotContent {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
  const relations = clone(parts.relations)
  return {
    units: clone(parts.units),
    positions: clone(parts.positions),
    relations,
    evidences: clone(parts.evidences),
    retractions: clone(parts.retractions),
    closure: snapshotClosure(relations),
  }
}

/** 取出快照封存的内容部分（去掉版本元数据） */
export function contentOf(s: Snapshot): SnapshotContent {
  return {
    units: s.units,
    positions: s.positions,
    relations: s.relations,
    evidences: s.evidences,
    retractions: s.retractions,
    closure: s.closure,
  }
}

/** 规范化内容：各表按主键排序后稳定序列化，保证同样内容得到同样摘要 */
export function canonicalizeContent(content: SnapshotContent): string {
  const byKey = <T>(arr: T[], key: (t: T) => string): T[] =>
    [...arr].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  return stableStringify({
    units: byKey(content.units, (u) => u.id),
    positions: byKey(content.positions, (p) => p.unitId),
    relations: byKey(content.relations, (r) => r.id),
    evidences: byKey(content.evidences, (e) => e.id),
    retractions: byKey(content.retractions, (x) => x.id),
    closure: [...content.closure].sort(),
  })
}

/** 内容摘要：链式衔接上一版摘要，任何一版被篡改都会破坏后续校验 */
export function computeDigest(prevDigest: string, content: SnapshotContent): string {
  return sha256Hex(`${prevDigest}\n${canonicalizeContent(content)}`)
}

/* ---------- 发布前检查：成环冲突与悬空引用 ---------- */

export function findPublishBlockers(
  units: StratUnit[],
  positions: UnitPosition[],
  relations: Relation[],
  evidences: Evidence[],
  retractions: Retraction[],
  label: (unitId: string) => string = (id) => id,
): PublishBlocker[] {
  const blockers: PublishBlocker[] = []
  const unitIds = new Set(units.map((u) => u.id))
  const relationIds = new Set(relations.map((r) => r.id))
  const evidenceIds = new Set(evidences.map((e) => e.id))

  // 悬空引用：任何记录指向不存在的对象，都不得封入快照
  for (const r of relations) {
    const text = `${label(r.from)} → ${label(r.to)}`
    if (!unitIds.has(r.from)) {
      blockers.push({ kind: 'dangling', message: `悬空引用：关系「${text}」的起点层位 ${r.from} 不存在` })
    }
    if (!unitIds.has(r.to)) {
      blockers.push({ kind: 'dangling', message: `悬空引用：关系「${text}」的终点层位 ${r.to} 不存在` })
    }
    for (const ev of r.evidenceIds) {
      if (!evidenceIds.has(ev)) {
        blockers.push({ kind: 'dangling', message: `悬空引用：关系「${text}」引用的证据 ${ev} 不存在` })
      }
    }
  }
  for (const p of positions) {
    if (!unitIds.has(p.unitId)) {
      blockers.push({ kind: 'dangling', message: `悬空引用：位置记录指向不存在的层位 ${p.unitId}` })
    }
  }
  for (const x of retractions) {
    if (!relationIds.has(x.relationId)) {
      blockers.push({ kind: 'dangling', message: `悬空引用：撤销记录指向不存在的关系 ${x.relationId}` })
    }
  }

  // 成环冲突：在活跃“早于”关系构成的有向图中，凡能找到回程路径的边都在环上
  const edges = activeEarlierEdges(relations)
  const g = buildGraph(edges)
  const reported = new Set<string>()
  for (const e of edges) {
    const back = findPath(g, e.to, e.from)
    if (!back) continue
    const cycle = [e.from, ...back]
    // 同一组节点构成的环只报告一次
    const key = [...new Set(cycle)].sort().join('→')
    if (reported.has(key)) continue
    reported.add(key)
    blockers.push({ kind: 'cycle', message: `成环冲突：${cycle.map(label).join(' → ')}` })
  }
  return blockers
}

/* ---------- 差异审查 ---------- */

function directPairSet(relations: Relation[]): Set<string> {
  return new Set(
    relations
      .filter((r) => r.status === 'active' && r.kind === 'earlier')
      .map((r) => `${r.from}→${r.to}`),
  )
}

/**
 * 比较两版内容，差异分三类：
 *  - 实体变化：层位与位置记录本身的增删改；
 *  - 直接关系变化：关系记录的增删改；
 *  - 语义变化：偏序闭包中不对应任何直接边的可达对增减（仅由闭包推导造成）。
 */
export function diffContents(a: SnapshotContent, b: SnapshotContent): SnapshotDiff {
  const diff: SnapshotDiff = {
    units: { added: [], removed: [], changed: [] },
    positions: { added: [], removed: [], moved: [] },
    relations: { added: [], removed: [], changed: [] },
    closure: { addedPairs: [], removedPairs: [] },
  }

  const aUnits = new Map(a.units.map((u) => [u.id, u]))
  const bUnits = new Map(b.units.map((u) => [u.id, u]))
  for (const u of b.units) {
    const before = aUnits.get(u.id)
    if (!before) diff.units.added.push(u)
    else if (stableStringify(before) !== stableStringify(u)) diff.units.changed.push({ before, after: u })
  }
  for (const u of a.units) if (!bUnits.has(u.id)) diff.units.removed.push(u)

  const aPos = new Map(a.positions.map((p) => [p.unitId, p]))
  const bPos = new Map(b.positions.map((p) => [p.unitId, p]))
  for (const p of b.positions) {
    const before = aPos.get(p.unitId)
    if (!before) diff.positions.added.push(p)
    else if (before.x !== p.x || before.y !== p.y) diff.positions.moved.push({ unitId: p.unitId, before, after: p })
  }
  for (const p of a.positions) if (!bPos.has(p.unitId)) diff.positions.removed.push(p)

  const aRels = new Map(a.relations.map((r) => [r.id, r]))
  const bRels = new Map(b.relations.map((r) => [r.id, r]))
  for (const r of b.relations) {
    const before = aRels.get(r.id)
    if (!before) diff.relations.added.push(r)
    else if (stableStringify(before) !== stableStringify(r)) diff.relations.changed.push({ before, after: r })
  }
  for (const r of a.relations) if (!bRels.has(r.id)) diff.relations.removed.push(r)

  // 语义变化：从关系记录重算闭包（不依赖封存的 closure 字段，保证以内容为准）
  const pairsA = new Set(snapshotClosure(a.relations))
  const pairsB = new Set(snapshotClosure(b.relations))
  const directA = directPairSet(a.relations)
  const directB = directPairSet(b.relations)
  // 新增可达对中，若在 B 版有对应直接边，则属于直接关系变化，不计入语义变化
  diff.closure.addedPairs = [...pairsB].filter((p) => !pairsA.has(p) && !directB.has(p)).sort()
  // 消失可达对中，若在 A 版本是直接边，同样已由关系变化体现
  diff.closure.removedPairs = [...pairsA].filter((p) => !pairsB.has(p) && !directA.has(p)).sort()
  return diff
}

/* ---------- 链式完整性校验 ---------- */

/** 校验单个快照：内容摘要与封存的闭包都必须与内容一致 */
export function verifySnapshotContent(s: Snapshot): string[] {
  const issues: string[] = []
  if (computeDigest(s.prevDigest, contentOf(s)) !== s.digest) {
    issues.push(`v${s.version}：内容摘要校验失败，记录可能被篡改`)
  }
  if (JSON.stringify(snapshotClosure(s.relations)) !== JSON.stringify([...s.closure].sort())) {
    issues.push(`v${s.version}：封存的偏序闭包与关系记录不一致，可能被篡改`)
  }
  return issues
}

/**
 * 校验整条发布链：版本号必须从 1 开始连续递增，
 * 每版前置摘要与上一版衔接，且每版内容摘要均有效。
 */
export function verifySnapshotChain(snapshots: Snapshot[]): string[] {
  const issues: string[] = []
  const sorted = [...snapshots].sort((a, b) => a.version - b.version)
  let prev: Snapshot | null = null
  sorted.forEach((s, i) => {
    if (s.version !== i + 1) {
      issues.push(`v${s.version}：版本号不连续（第 ${i + 1} 个快照），可能有发布记录被删除或插入`)
    }
    const expectedPrev = prev?.digest ?? GENESIS_DIGEST
    if (s.prevDigest !== expectedPrev) {
      issues.push(`v${s.version}：前置摘要与上一版本不衔接，版本链被破坏`)
    }
    issues.push(...verifySnapshotContent(s))
    prev = s
  })
  return issues
}
