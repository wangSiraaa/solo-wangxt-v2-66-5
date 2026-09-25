import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db'
import {
  addRelation,
  addUnit,
  checkPublishability,
  clearAll,
  currentContent,
  deriveWorkspace,
  exportProjectData,
  importProjectData,
  latestVersion,
  publishSnapshot,
  refresh,
  state,
} from '../src/store'
import { captureContent, diffContents, validateForPublish } from '../src/snapshot'
import type { Evidence, ProjectExport, Relation, Retraction, Snapshot, StratUnit, UnitPosition } from '../src/types'

/* ---------- 测试数据构造 ---------- */

let seq = 0
function now() {
  return Date.now() + seq++
}

/** 按 id 稳定的时间戳：同一逻辑实体跨“重建工作区”保持完全相同 */
const stampClock = new Map<string, number>()
function stamp(id: string): number {
  let t = stampClock.get(id)
  if (t === undefined) {
    t = 1000 + stampClock.size
    stampClock.set(id, t)
  }
  return t
}

function unit(id: string): StratUnit {
  return { id, label: id, type: 'deposit', note: '', createdAt: stamp('u:' + id) }
}

function evidence(id: string): Evidence {
  return { id, ref: `证据${id}`, text: '', createdAt: stamp('e:' + id) }
}

function relation(r: Partial<Relation> & { from: string; to: string }): Relation {
  return {
    id: r.id ?? `R${Math.random().toString(36).slice(2, 8)}`,
    from: r.from,
    to: r.to,
    kind: r.kind ?? 'earlier',
    source: r.source ?? 'observation',
    status: r.status ?? 'active',
    conflict: r.conflict ?? false,
    evidenceIds: r.evidenceIds ?? [],
    note: r.note ?? '',
    createdAt: r.createdAt ?? (r.id ? stamp('r:' + r.id) : now()),
  }
}

/** 直接构造一个工程到工作区五张表（绕过 UI 交互） */
async function loadWorkspace(p: {
  units: StratUnit[]
  positions?: UnitPosition[]
  relations?: Relation[]
  evidences?: Evidence[]
  retractions?: Retraction[]
}) {
  await db.transaction(
    'rw',
    [db.units, db.positions, db.relations, db.evidences, db.retractions, db.batches, db.meta],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.batches.clear(),
      ])
      await db.units.bulkPut(deepClone(p.units))
      if (p.positions) await db.positions.bulkPut(deepClone(p.positions))
      if (p.evidences) await db.evidences.bulkPut(deepClone(p.evidences))
      if (p.relations) await db.relations.bulkPut(deepClone(p.relations))
      if (p.retractions) await db.retractions.bulkPut(deepClone(p.retractions))
    },
  )
  await refresh()
}

/** 写入 IndexedDB 前剥离 Vue 响应式代理（与 store 的 plain 口径一致） */
function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

beforeEach(async () => {
  // 浏览器 API 桩（store 中用于提示/确认；测试里不应阻塞）
  vi.stubGlobal('window', {
    confirm: () => true,
    alert: () => {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  })
  await clearAll(false)
  seq = 0
})

/* ============================== 验收 1：版本号稳定 & 不可变 ============================== */

describe('连续发布：版本号单调稳定，快照不可变', () => {
  it('版本号 1、2、3 单调递增，parent 链正确，内容冻结不随后续编辑改变', async () => {
    await loadWorkspace({ units: [unit('A'), unit('B')], relations: [relation({ id: 'r1', from: 'A', to: 'B' })] })

    const v1 = await publishSnapshot('首版')
    const snap1Before = JSON.stringify(state.snapshots.find((s) => s.version === 1)!.content)
    await loadWorkspace({
      units: [unit('A'), unit('B'), unit('C')],
      relations: [relation({ id: 'r1', from: 'A', to: 'B' }), relation({ id: 'r2', from: 'B', to: 'C' })],
    })
    const v2 = await publishSnapshot('加入 C')
    await loadWorkspace({ units: [unit('A'), unit('B'), unit('C'), unit('D')] })
    const v3 = await publishSnapshot('加入 D')

    expect([v1, v2, v3]).toEqual([1, 2, 3])
    expect(latestVersion.value).toBe(3)

    const snaps = state.snapshots
    expect(snaps.map((s) => s.version)).toEqual([1, 2, 3])
    expect(snaps.map((s) => s.parentVersion)).toEqual([null, 1, 2])
    expect(snaps.map((s) => s.note)).toEqual(['首版', '加入 C', '加入 D'])

    // 不可变：v1 内容仍是发布时的两个层位，未被后续工作区编辑影响
    const v1Content = snaps.find((s) => s.version === 1)!.content
    expect(v1Content.units.map((u) => u.id).sort()).toEqual(['A', 'B'])
    expect(snap1Before).toBe(JSON.stringify(v1Content))
    expect(v1Content.partialOrder).toEqual(['A→B'])
  })

  it('snapshots 表只有新增路径：应用层不提供更新/删除接口', async () => {
    await loadWorkspace({ units: [unit('A')] })
    await publishSnapshot('')
    // 即便直接尝试以已存在版本号写回，add 语义也必须拒绝（发布实现用 add 而非 put）
    await expect(
      db.snapshots.add({ ...state.snapshots[0], note: '试图覆写' }),
    ).rejects.toBeTruthy()
    const still = await db.snapshots.get(1)
    expect(still!.note).toBe('')
  })
})

/* ============================== 验收 2：直接边修改后的语义差异 ============================== */

describe('差异审查：实体 / 直接关系 / 闭包语义三分', () => {
  it('新增不直接成边的关系：只出现③语义推导变化，不污染直接关系差异', async () => {
    // v1: A→B, B→C, A→C（A→C 是直接记录的冗余边）
    await loadWorkspace({
      units: [unit('A'), unit('B'), unit('C')],
      relations: [
        relation({ id: 'ab', from: 'A', to: 'B' }),
        relation({ id: 'bc', from: 'B', to: 'C' }),
        relation({ id: 'ac', from: 'A', to: 'C' }),
      ],
    })
    await publishSnapshot('v1')
    const v1 = currentContent()

    // 工作区删除直接边 A→C：它本就被 A→B→C 蕴含
    await loadWorkspace({
      units: [unit('A'), unit('B'), unit('C')],
      relations: [
        relation({ id: 'ab', from: 'A', to: 'B' }),
        relation({ id: 'bc', from: 'B', to: 'C' }),
      ],
    })
    const d1 = diffContents(v1, currentContent())
    expect(d1.relations.map((c) => c.id)).toEqual(['ac'])
    expect(d1.relations[0].kind).toBe('removed')
    expect(d1.directEdgePairs.map((c) => `${c.kind}:${c.pair}`)).toEqual(['removed:A→C'])
    // 关键：闭包未变 → 没有任何语义差异
    expect(d1.semanticClosure).toEqual([])
    expect(d1.directPairsWithoutSemanticEffect.map((c) => c.pair)).toEqual(['A→C'])

    // 工作区新增直接边 C→D（D 此前无任何关系）：直接边 + 语义推导同时出现
    await loadWorkspace({
      units: [unit('A'), unit('B'), unit('C'), unit('D')],
      relations: [
        relation({ id: 'ab', from: 'A', to: 'B' }),
        relation({ id: 'bc', from: 'B', to: 'C' }),
        relation({ id: 'cd', from: 'C', to: 'D' }),
      ],
    })
    const d2 = diffContents(v1, currentContent())
    // 直接边：删除 v1 中冗余的 A→C，新增 C→D（A→C 同时也由新闭包推出，故无语义影响）
    expect(d2.directEdgePairs.map((c) => `${c.kind}:${c.pair}`).sort()).toEqual(['added:C→D', 'removed:A→C'])
    // 仅由闭包推导的语义新增（A→C 在 v1 也有，故不在差异里）
    const semanticAdded = d2.semanticClosure.filter((c) => c.kind === 'added').map((c) => c.pair)
    expect(semanticAdded.sort()).toEqual(['A→D', 'B→D'])
    expect(d2.units.map((c) => c.id)).toEqual(['D'])
    expect(d2.units[0].kind).toBe('added')
    // A→C 的直接边改动不产生语义变化
    expect(d2.directPairsWithoutSemanticEffect.map((c) => `${c.kind}:${c.pair}`)).toEqual(['removed:A→C'])
  })

  it('删除中间边：直接关系变化与语义丢失分别归类', async () => {
    await loadWorkspace({
      units: [unit('A'), unit('B'), unit('C')],
      relations: [
        relation({ id: 'ab', from: 'A', to: 'B' }),
        relation({ id: 'bc', from: 'B', to: 'C' }),
      ],
    })
    await publishSnapshot('链')
    const before = state.snapshots[0].content
    // 撤回中间边 B→C
    const retractedBc = { ...before.relations.find((r) => r.id === 'bc')!, status: 'retracted' as const }
    await loadWorkspace({
      units: before.units.map((u) => ({ ...u })),
      relations: [before.relations.find((r) => r.id === 'ab')!, retractedBc],
    })
    const d = diffContents(before, currentContent())
    expect(d.relations.map((c) => `${c.kind}:${c.id}`)).toEqual(['modified:bc'])
    expect(d.directEdgePairs.map((c) => `${c.kind}:${c.pair}`)).toEqual(['removed:B→C'])
    expect(d.semanticClosure.map((c) => `${c.kind}:${c.pair}`)).toEqual(['removed:A→C'])
  })

  it('实体修改（备注/类型）与撤回/冲突标记变化归入直接关系变化', async () => {
    await loadWorkspace({
      units: [unit('A'), unit('B')],
      relations: [relation({ id: 'ab', from: 'A', to: 'B', conflict: false })],
    })
    await publishSnapshot('')
    const before = state.snapshots[0].content
    await loadWorkspace({
      units: [{ ...unit('A'), note: '补充田野说明' }, unit('B')],
      relations: [
        { id: 'ab', from: 'A', to: 'B', kind: 'earlier', source: 'observation', status: 'active', conflict: true, evidenceIds: [], note: '', createdAt: 1 },
      ],
    })
    const d = diffContents(before, currentContent())
    expect(d.units.length).toBe(1)
    expect(d.units[0].kind).toBe('modified')
    expect(d.relations.length).toBe(1)
    expect(d.relations[0].kind).toBe('modified')
    expect(d.relations[0].before!.conflict).toBe(false)
    expect(d.relations[0].after!.conflict).toBe(true)
  })

  it('快照与快照也可比较', async () => {
    await loadWorkspace({ units: [unit('A'), unit('B')], relations: [relation({ id: 'ab', from: 'A', to: 'B' })] })
    await publishSnapshot('')
    await loadWorkspace({
      units: [unit('A'), unit('B'), unit('C')],
      relations: [relation({ id: 'ab', from: 'A', to: 'B' }), relation({ id: 'bc', from: 'B', to: 'C' })],
    })
    await publishSnapshot('')
    const [s1, s2] = state.snapshots
    const d = diffContents(s1.content, s2.content)
    expect(d.units.map((c) => c.id)).toEqual(['C'])
    expect(d.semanticClosure.map((c) => c.pair)).toEqual(['A→C'])
  })
})

/* ============================== 验收 3：从旧快照派生不影响快照链 ============================== */

describe('从历史快照派生', () => {
  it('派生后工作区内容回退、基线更新，再发布版本号接尾部且旧快照不变', async () => {
    await loadWorkspace({ units: [unit('A'), unit('B')], relations: [relation({ id: 'ab', from: 'A', to: 'B' })] })
    await publishSnapshot('v1')
    await loadWorkspace({
      units: [unit('A'), unit('B'), unit('C')],
      relations: [relation({ id: 'ab', from: 'A', to: 'B' }), relation({ id: 'bc', from: 'B', to: 'C' })],
    })
    await publishSnapshot('v2')

    const s1 = state.snapshots.find((s) => s.version === 1)!
    const s2Digest = state.snapshots.find((s) => s.version === 2)!.digest

    const ok = await deriveWorkspace(1)
    expect(ok).toBe(true)
    // 工作区回到 v1
    expect(state.units.map((u) => u.id).sort()).toEqual(['A', 'B'])
    expect(state.relations.length).toBe(1)
    expect(state.workspaceBase).toBe(1)
    // 快照链原样保留
    expect(state.snapshots.map((s) => s.version)).toEqual([1, 2])
    expect(state.snapshots.find((s) => s.version === 2)!.digest).toBe(s2Digest)
    expect(s1.content.units.length).toBe(2)

    // 在派生工作区上发布：新版本号接全链尾部（v3），且记录 derivedFromVersion=1（分支）
    const v3 = await publishSnapshot('从 v1 派生后的发布')
    expect(v3).toBe(3)
    const snap3 = state.snapshots.find((s) => s.version === 3)!
    expect(snap3.derivedFromVersion).toBe(1)
    expect(snap3.parentVersion).toBe(2)
    // v1/v2 仍不可变
    expect(state.snapshots.find((s) => s.version === 1)!.publishedAt).toBe(s1.publishedAt)
    expect(state.workspaceBase).toBe(3)
  })

  it('派生被篡改的快照会被拒绝，工作区保持不变', async () => {
    await loadWorkspace({ units: [unit('A')] })
    await publishSnapshot('')
    // 直接在 IndexedDB 中篡改快照内容（绕过应用）
    const tampered = { ...(await db.snapshots.get(1))! }
    tampered.content = { ...tampered.content, units: [unit('ZZ')] }
    // 应用只提供 add（不覆写），这里模拟外部损坏：先删后塞
    await db.snapshots.delete(1)
    await db.snapshots.add(tampered)
    await refresh()
    expect(state.snapshotProblems[1]).toBeTruthy()
    expect(state.snapshotProblems[1].length).toBeGreaterThan(0)

    const unitsBefore = state.units.map((u) => u.id)
    const ok = await deriveWorkspace(1)
    expect(ok).toBe(false)
    await refresh()
    expect(state.units.map((u) => u.id)).toEqual(unitsBefore)
  })
})

/* ============================== 验收 4：冲突阻止发布，修复后可重试 ============================== */

describe('发布前校验：成环 / 悬空', () => {
  it('存在成环冲突时阻止发布并列出环路径；修复后同说明可重试成功', async () => {
    await loadWorkspace({
      units: [unit('A'), unit('B'), unit('C')],
      relations: [
        relation({ id: 'ab', from: 'A', to: 'B' }),
        relation({ id: 'bc', from: 'B', to: 'C' }),
        relation({ id: 'ca', from: 'C', to: 'A' }), // 闭合 A→B→C→A
      ],
    })
    const check = checkPublishability()
    expect(check.blocked).toBe(true)
    expect(check.cycleConflicts.length).toBe(1)
    expect(check.cycleConflicts[0].relationId).toBe('ca')
    expect(check.cycleConflicts[0].path).toEqual(['C', 'A', 'B', 'C'])
    expect(check.reasons.join(' ')).toContain('成环')

    expect(await publishSnapshot('带环')).toBeNull()
    expect(await db.snapshots.count()).toBe(0) // 失败不留任何版本

    // 修复：撤回成环边后重试同一发布动作
    await db.relations.update('ca', { status: 'retracted' })
    await refresh()
    expect(checkPublishability().blocked).toBe(false)
    expect(await publishSnapshot('修复后发布')).toBe(1)
  })

  it('自环也算成环冲突', async () => {
    await loadWorkspace({
      units: [unit('A')],
      relations: [relation({ id: 'self', from: 'A', to: 'A' })],
    })
    const check = validateForPublish({
      units: state.units,
      positions: [],
      relations: state.relations,
      evidences: [],
      retractions: [],
    })
    expect(check.blocked).toBe(true)
    expect(check.reasons[0]).toContain('成环')
  })

  it('悬空引用（位置/关系/证据/撤销记录）逐条列出并阻止', async () => {
    const danglingRel = relation({ id: 'rx', from: 'A', to: 'GHOST' })
    danglingRel.evidenceIds = ['E_MISSING']
    await loadWorkspace({
      units: [unit('A')],
      positions: [{ unitId: 'GHOSTPOS', x: 1, y: 2 }],
      evidences: [evidence('E1')],
      relations: [danglingRel],
      retractions: [
        {
          id: 'x1',
          relationId: 'R_MISSING',
          snapshot: relation({ id: 'R_MISSING', from: 'A', to: 'GHOST2' }),
          reason: '测试',
          at: now(),
        },
      ],
    })
    const check = checkPublishability()
    expect(check.blocked).toBe(true)
    expect(check.dangling.length).toBeGreaterThanOrEqual(4)
    expect(check.reasons.some((r) => r.includes('GHOST'))).toBe(true)
    expect(check.reasons.some((r) => r.includes('E_MISSING'))).toBe(true)
    expect(check.reasons.some((r) => r.includes('GHOSTPOS'))).toBe(true)
    expect(check.reasons.some((r) => r.includes('R_MISSING'))).toBe(true)
    expect(await publishSnapshot('')).toBeNull()
  })

  it('通过 UI 新增矛盾边的工程同样无法发布', async () => {
    await addUnit('A', 'deposit', '')
    await addUnit('B', 'deposit', '')
    await addRelation({ from: 'A', to: 'B', kind: 'earlier', source: 'observation', evidenceIds: [], note: '' })
    await addRelation({ from: 'B', to: 'A', kind: 'earlier', source: 'observation', evidenceIds: [], note: '' }, true)
    expect(state.relations.some((r) => r.conflict)).toBe(true)
    expect(checkPublishability().blocked).toBe(true)
  })
})

/* ============================== 验收 5：刷新 / JSON 往返 / 篡改识别 ============================== */

describe('刷新与工程 JSON 往返', () => {
  it('刷新后摘要校验、版本关系保持', async () => {
    await loadWorkspace({ units: [unit('A'), unit('B')], relations: [relation({ from: 'A', to: 'B' })] })
    await publishSnapshot('第一版')
    await refresh()
    expect(state.snapshots.length).toBe(1)
    expect(state.snapshotProblems).toEqual({})
    expect(state.workspaceBase).toBe(1)
    expect(state.snapshots[0].parentVersion).toBeNull()
  })

  it('JSON 往返后：摘要一致、版本关系一致、差异结果一致', async () => {
    await loadWorkspace({
      units: [unit('A'), unit('B'), unit('C')],
      positions: [
        { unitId: 'A', x: 10, y: 20 },
        { unitId: 'B', x: 30, y: 40 },
      ],
      evidences: [evidence('E1')],
      relations: [
        relation({ id: 'ab', from: 'A', to: 'B', evidenceIds: ['E1'] }),
        relation({ id: 'bc', from: 'B', to: 'C' }),
      ],
    })
    await publishSnapshot('往返版')
    const beforeExport = JSON.stringify({
      snaps: state.snapshots.map((s) => ({ v: s.version, digest: s.digest, parent: s.parentVersion })),
      base: state.workspaceBase,
    })
    const diffBefore = diffContents(state.snapshots[0].content, currentContent())

    // 导出 → 模拟文件往返 → 导入
    const file = exportProjectData()
    const roundTrip = JSON.parse(JSON.stringify(file)) as ProjectExport
    const imported = await importProjectData(roundTrip)
    expect(imported.ok).toBe(true)

    expect(
      JSON.stringify({
        snaps: state.snapshots.map((s) => ({ v: s.version, digest: s.digest, parent: s.parentVersion })),
        base: state.workspaceBase,
      }),
    ).toBe(beforeExport)
    expect(state.snapshotProblems).toEqual({})

    const diffAfter = diffContents(state.snapshots[0].content, currentContent())
    expect(JSON.stringify(diffAfter)).toBe(JSON.stringify(diffBefore))
    expect(diffAfter.isEmpty).toBe(true)
  })

  it('导入被篡改快照的工程文件时拒绝整次导入', async () => {
    await loadWorkspace({ units: [unit('A')] })
    await publishSnapshot('原版')
    const file = exportProjectData()
    const tamperedFile = JSON.parse(JSON.stringify(file)) as ProjectExport
    // 篡改 v1 内容但保留原 digest
    tamperedFile.snapshots![0].content.units[0].label = '被篡改'
    const imported = await importProjectData(tamperedFile)
    expect(imported.ok).toBe(false)
    // 工作区未被替换
    await refresh()
    expect(state.snapshots.length).toBe(1)
    expect(state.snapshots[0].content.units[0].label).toBe('A')
  })

  it('旧版工程文件（无快照字段）可正常导入', async () => {
    const legacy = {
      app: 'harris-matrix-workbench',
      version: 1,
      exportedAt: new Date().toISOString(),
      units: [unit('A'), unit('B')],
      positions: [],
      relations: [relation({ from: 'A', to: 'B' })],
      evidences: [],
      retractions: [],
      partialOrder: ['A→B'],
    } as unknown as ProjectExport
    const imported = await importProjectData(legacy)
    expect(imported.ok).toBe(true)
    expect(state.snapshots.length).toBe(0)
    expect(state.workspaceBase).toBeNull()
  })

  it('内容摘要对等价内容稳定：字段顺序与数组顺序变化不改变 digest', async () => {
    const units = [unit('A'), unit('B')]
    const rel = relation({ id: 'r1', from: 'A', to: 'B' })
    const c1 = captureContent({ units, positions: [], relations: [rel], evidences: [], retractions: [] })
    const c2 = JSON.parse(JSON.stringify(c1))
    // 打乱数组顺序
    c2.units = [c1.units[1], c1.units[0]]

    // 手工构造键顺序完全不同的等价内容（canonicalJSON 会重排键）
    const reordered: Snapshot['content'] = {
      partialOrder: ['A→B'],
      contentVersion: 1,
      retractions: [],
      relations: [{ ...rel }],
      positions: [],
      evidences: [],
      units: [...units],
      app: 'harris-matrix-workbench',
    }

    const { computeDigest } = await import('../src/snapshot')
    const d1 = await computeDigest(c1)
    expect(await computeDigest(c2)).toBe(d1)
    expect(await computeDigest(reordered)).toBe(d1)

    // 任意实质改动都必须改变摘要
    c2.relations[0].note = '改动'
    expect(await computeDigest(c2)).not.toBe(d1)
  })
})
