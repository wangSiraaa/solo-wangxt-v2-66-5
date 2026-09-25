import 'fake-indexeddb/auto'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import * as store from './store'
import { sha256Hex, stableStringify } from './digest'
import type { Relation } from './types'

/* ---------- 测试辅助 ---------- */

async function resetDb() {
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
  await store.refresh()
}

const uidOf = (label: string) => store.state.units.find((u) => u.label === label)!.id

async function addEarlier(fromLabel: string, toLabel: string) {
  await store.addRelation({
    from: uidOf(fromLabel),
    to: uidOf(toLabel),
    kind: 'earlier',
    source: 'observation',
    evidenceIds: [],
    note: '',
  })
}

const pair = (a: string, b: string) => `${uidOf(a)}→${uidOf(b)}`

beforeEach(resetDb)

/* ---------- 摘要原语 ---------- */

describe('摘要原语', () => {
  it('SHA-256 与标准实现一致', () => {
    const cases = ['', 'abc', 'hello world', '地层矩阵·快照·v1', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000)]
    for (const c of cases) {
      expect(sha256Hex(c)).toBe(createHash('sha256').update(c, 'utf8').digest('hex'))
    }
  })

  it('稳定序列化与对象键序无关', () => {
    const a = stableStringify({ x: 1, y: [1, { b: 2, a: 3 }] })
    const b = stableStringify({ y: [1, { a: 3, b: 2 }], x: 1 })
    expect(a).toBe(b)
  })
})

/* ---------- 发布：版本稳定与不可变 ---------- */

describe('发布快照', () => {
  it('连续发布版本号稳定且快照不可变', async () => {
    await store.addUnit('A', 'deposit', '')
    await store.addUnit('B', 'deposit', '')
    await addEarlier('A', 'B')

    const r1 = await store.publishSnapshot('第一版')
    const r2 = await store.publishSnapshot('第二版')
    expect(r1.ok && r2.ok).toBe(true)
    expect(r1.snapshot!.version).toBe(1)
    expect(r2.snapshot!.version).toBe(2)
    // 链式衔接：v2 的前置摘要指向 v1，内容相同摘要也不同
    expect(r2.snapshot!.prevDigest).toBe(r1.snapshot!.digest)
    expect(r2.snapshot!.digest).not.toBe(r1.snapshot!.digest)

    // 继续编辑工作区并发布 v3
    await store.addUnit('C', 'fill', '')
    const r3 = await store.publishSnapshot('第三版')
    expect(r3.snapshot!.version).toBe(3)
    expect(r3.snapshot!.prevDigest).toBe(r2.snapshot!.digest)

    // 不可变：库中的 v1 与发布时完全一致，不受后续编辑影响
    const v1 = (await db.snapshots.get(r1.snapshot!.id))!
    expect(v1.digest).toBe(r1.snapshot!.digest)
    expect(v1.units.length).toBe(2)
    expect(v1.relations.length).toBe(1)
    expect(store.state.snapshotIssues).toEqual([])
  })

  it('存在成环冲突时发布被拒绝，修复后可重试', async () => {
    await store.addUnit('A', 'deposit', '')
    await store.addUnit('B', 'deposit', '')
    await addEarlier('A', 'B')
    // B→A 将成环：挂起后确认保留为矛盾记录
    await store.addRelation({
      from: uidOf('B'),
      to: uidOf('A'),
      kind: 'earlier',
      source: 'observation',
      evidenceIds: [],
      note: '',
    })
    expect(store.state.pendingCycle).not.toBeNull()
    await store.confirmCycle()
    expect(store.state.relations.some((r) => r.conflict)).toBe(true)

    const res = await store.publishSnapshot('含冲突')
    expect(res.ok).toBe(false)
    expect(res.blockers.some((b) => b.kind === 'cycle')).toBe(true)
    expect(res.blockers.map((b) => b.message).join('\n')).toContain('成环')
    // 拒绝发布不产生任何版本
    expect(await db.snapshots.count()).toBe(0)

    // 修复：撤回矛盾关系后重试成功
    const conflict = store.state.relations.find((r) => r.conflict)!
    await store.retractRelation(conflict.id, '复核后撤回')
    const retry = await store.publishSnapshot('修复后')
    expect(retry.ok).toBe(true)
    expect(retry.snapshot!.version).toBe(1)
    expect(store.state.snapshotIssues).toEqual([])
  })

  it('存在悬空引用时发布被拒绝并列出全部原因', async () => {
    await store.addUnit('A', 'deposit', '')
    const aId = uidOf('A')
    // 直接写入损坏数据（模拟外部写入/历史遗留）：悬空层位、悬空证据、悬空位置、悬空撤销记录
    await db.relations.put({
      id: 'RX',
      from: 'ghost-unit',
      to: aId,
      kind: 'earlier',
      source: 'observation',
      status: 'active',
      conflict: false,
      evidenceIds: ['ghost-evidence'],
      note: '',
      createdAt: 1,
    })
    await db.positions.put({ unitId: 'ghost-pos', x: 0, y: 0 })
    await db.retractions.put({ id: 'XX', relationId: 'ghost-rel', snapshot: {} as Relation, reason: '', at: 1 })
    await store.refresh()

    const res = await store.publishSnapshot('x')
    expect(res.ok).toBe(false)
    expect(res.blockers.every((b) => b.kind === 'dangling')).toBe(true)
    const msgs = res.blockers.map((b) => b.message).join('\n')
    expect(msgs).toContain('ghost-unit')
    expect(msgs).toContain('ghost-evidence')
    expect(msgs).toContain('ghost-pos')
    expect(msgs).toContain('ghost-rel')
    expect(await db.snapshots.count()).toBe(0)

    // 清理悬空记录后可正常发布
    await db.relations.delete('RX')
    await db.positions.delete('ghost-pos')
    await db.retractions.delete('XX')
    await store.refresh()
    expect((await store.publishSnapshot('x')).ok).toBe(true)
  })

  it('示例工程：含矛盾记录时阻止发布，撤回后可发布', async () => {
    await store.loadSample()
    expect(store.state.relations.some((r) => r.conflict && r.status === 'active')).toBe(true)
    const blocked = await store.publishSnapshot('示例')
    expect(blocked.ok).toBe(false)
    expect(blocked.blockers.some((b) => b.kind === 'cycle')).toBe(true)
    expect(await db.snapshots.count()).toBe(0)
    // 撤回矛盾记录后发布成功，且发布链校验通过
    const conflict = store.state.relations.find((r) => r.conflict && r.status === 'active')!
    await store.retractRelation(conflict.id, '测试撤回')
    const ok = await store.publishSnapshot('示例')
    expect(ok.ok).toBe(true)
    expect(store.state.snapshotIssues).toEqual([])
  })

  it('事务失败时不产生空版本，版本号不被失败占用', async () => {
    await store.addUnit('A', 'deposit', '')
    // 用 Dexie 钩子模拟写入失败
    const fail = () => {
      throw new Error('模拟写入失败')
    }
    db.snapshots.hook('creating', fail)
    let res: Awaited<ReturnType<typeof store.publishSnapshot>> | undefined
    try {
      res = await store.publishSnapshot('x')
    } finally {
      db.snapshots.hook('creating').unsubscribe(fail)
    }
    expect(res!.ok).toBe(false)
    expect(await db.snapshots.count()).toBe(0)
    expect(store.state.snapshots.length).toBe(0)

    // 重试成功，且版本号从 1 开始（失败未留下空版本/占位版本）
    const retry = await store.publishSnapshot('重试')
    expect(retry.ok).toBe(true)
    expect(retry.snapshot!.version).toBe(1)
  })
})

/* ---------- 差异审查 ---------- */

describe('差异审查', () => {
  it('新增直接边后：直接关系与闭包语义差异准确区分', async () => {
    for (const l of ['A', 'B', 'C', 'D']) await store.addUnit(l, 'deposit', '')
    await addEarlier('A', 'B')
    await addEarlier('B', 'C')
    const v1 = (await store.publishSnapshot('v1')).snapshot!

    await addEarlier('C', 'D')
    const diff = store.compareTargets(v1.id, 'workspace')!

    // 直接关系变化：仅 C→D 一条新增
    expect(diff.relations.added.map((r) => `${r.from}→${r.to}`)).toEqual([pair('C', 'D')])
    expect(diff.relations.removed).toEqual([])
    expect(diff.relations.changed).toEqual([])
    // 语义变化：A→D、B→D 仅由闭包推导；C→D 是直接边，不得计入
    expect(diff.closure.addedPairs).toEqual([pair('A', 'D'), pair('B', 'D')].sort())
    expect(diff.closure.removedPairs).toEqual([])
    // 实体无变化
    expect(diff.units.added.length + diff.units.removed.length + diff.units.changed.length).toBe(0)
  })

  it('撤销直接边后：消失的可达对中直接边不计入语义变化', async () => {
    for (const l of ['A', 'B', 'C', 'D']) await store.addUnit(l, 'deposit', '')
    await addEarlier('A', 'B')
    await addEarlier('B', 'C')
    await addEarlier('C', 'D')
    const v1 = (await store.publishSnapshot('v1')).snapshot!

    // 撤回 B→C：闭包失去 B→C（直接）、A→C、B→D、A→D（推导）
    const bc = store.state.relations.find((r) => r.from === uidOf('B') && r.to === uidOf('C'))!
    await store.retractRelation(bc.id, '复核撤回')
    const diff = store.compareTargets(v1.id, 'workspace')!

    // 直接关系变化：B→C 状态由活跃变为已撤销
    expect(diff.relations.changed.length).toBe(1)
    expect(diff.relations.changed[0].before.status).toBe('active')
    expect(diff.relations.changed[0].after.status).toBe('retracted')
    // 语义变化：仅闭包推导的 A→C、A→D、B→D；B→C 已由关系变化体现
    expect(diff.closure.removedPairs).toEqual([pair('A', 'C'), pair('A', 'D'), pair('B', 'D')].sort())
    expect(diff.closure.addedPairs).toEqual([])
  })

  it('实体与位置变化可区分', async () => {
    await store.addUnit('A', 'deposit', '')
    await store.savePosition(uidOf('A'), 1, 2)
    const v1 = (await store.publishSnapshot('v1')).snapshot!

    await store.addUnit('B', 'fill', '')
    await store.savePosition(uidOf('B'), 5, 6)
    await db.units.update(uidOf('A'), { note: '改过的备注' })
    await store.refresh()

    const diff = store.compareTargets(v1.id, 'workspace')!
    expect(diff.units.added.map((u) => u.label)).toEqual(['B'])
    expect(diff.units.changed.length).toBe(1)
    expect(diff.units.changed[0].after.note).toBe('改过的备注')
    expect(diff.positions.added.map((p) => p.unitId)).toEqual([uidOf('B')])

    // 反向比较：新增变移除
    const back = store.compareTargets('workspace', v1.id)!
    expect(back.units.removed.map((u) => u.label)).toEqual(['B'])
    expect(back.positions.removed.map((p) => p.unitId)).toEqual([uidOf('B')])

    // 位置移动：v1 中已有 A 的位置，再次拖动记为移动
    await store.savePosition(uidOf('A'), 50, 60)
    const moved = store.compareTargets(v1.id, 'workspace')!
    expect(moved.positions.moved.map((m) => m.unitId)).toEqual([uidOf('A')])
  })
})

/* ---------- 派生 ---------- */

describe('从快照派生', () => {
  async function setupTwoVersions() {
    await store.addUnit('A', 'deposit', '')
    await store.addUnit('B', 'deposit', '')
    await addEarlier('A', 'B')
    const v1 = (await store.publishSnapshot('v1')).snapshot!
    await store.addUnit('C', 'fill', '')
    await addEarlier('B', 'C')
    const v2 = (await store.publishSnapshot('v2')).snapshot!
    return { v1, v2 }
  }

  it('从旧快照派生不影响当前快照链', async () => {
    const { v1, v2 } = await setupTwoVersions()
    expect(store.state.snapshots.map((s) => s.version)).toEqual([1, 2])

    const ok = await store.deriveFromSnapshot(v1.id)
    expect(ok).toBe(true)
    // 工作区回到 v1 内容
    expect(store.state.units.map((u) => u.label)).toEqual(['A', 'B'])
    expect(store.activeRelations.value.length).toBe(1)
    // 快照链原样保留：不覆写、不删除
    expect(store.state.snapshots.map((s) => s.version)).toEqual([1, 2])
    expect(store.state.snapshots.map((s) => s.digest)).toEqual([v1.digest, v2.digest])
    expect(store.state.snapshotIssues).toEqual([])

    // 派生后继续发布：版本接续递增，前置摘要仍接 v2
    const r3 = await store.publishSnapshot('派生后归档')
    expect(r3.ok).toBe(true)
    expect(r3.snapshot!.version).toBe(3)
    expect(r3.snapshot!.prevDigest).toBe(v2.digest)
    expect(store.state.snapshotIssues).toEqual([])
  })

  it('派生登记为批次，可整体撤销', async () => {
    const { v1 } = await setupTwoVersions()
    await store.deriveFromSnapshot(v1.id)
    expect(store.state.units.length).toBe(2)
    await store.undo()
    expect(store.state.units.length).toBe(3)
    expect(store.activeRelations.value.length).toBe(2)
  })

  it('派生事务失败时工作区保持原样，不留空版本', async () => {
    const { v1 } = await setupTwoVersions()
    const unitsBefore = store.state.units.length
    const relsBefore = store.state.relations.length
    const batchesBefore = store.state.batches.length

    const fail = () => {
      throw new Error('模拟写入失败')
    }
    db.relations.hook('updating', fail)
    let ok = true
    try {
      ok = await store.deriveFromSnapshot(v1.id)
    } finally {
      db.relations.hook('updating').unsubscribe(fail)
    }
    expect(ok).toBe(false)
    // 内存与数据库都保持派生前状态（事务整体回滚）
    expect(store.state.units.length).toBe(unitsBefore)
    expect(store.state.relations.length).toBe(relsBefore)
    expect(store.state.batches.length).toBe(batchesBefore)
    expect(await db.units.count()).toBe(unitsBefore)
    expect(await db.relations.count()).toBe(relsBefore)
  })

  it('被篡改的快照拒绝派生', async () => {
    const { v1 } = await setupTwoVersions()
    const stored = (await db.snapshots.get(v1.id))!
    const tampered = JSON.parse(JSON.stringify(stored)) as typeof stored
    tampered.relations[0].note = '被篡改'
    await db.snapshots.put(tampered)
    await store.refresh()
    expect(store.state.snapshotIssues.length).toBeGreaterThan(0)
    expect(await store.deriveFromSnapshot(v1.id)).toBe(false)
  })
})

/* ---------- 刷新 / JSON 往返 / 篡改识别 ---------- */

describe('一致性与篡改识别', () => {
  async function setupAndExport() {
    await store.addUnit('A', 'deposit', '')
    await store.addUnit('B', 'deposit', '')
    await store.addUnit('C', 'fill', '')
    await addEarlier('A', 'B')
    const v1 = (await store.publishSnapshot('第一版')).snapshot!
    await addEarlier('B', 'C')
    await store.savePosition(uidOf('A'), 10, 20)
    const v2 = (await store.publishSnapshot('第二版')).snapshot!
    return { v1, v2 }
  }

  it('刷新后摘要校验、版本关系与差异结果保持一致', async () => {
    const { v1, v2 } = await setupAndExport()
    const diffBefore = store.compareTargets(v1.id, v2.id)
    const digestsBefore = store.state.snapshots.map((s) => s.digest)

    await store.refresh()
    await store.refresh()
    expect(store.state.snapshotIssues).toEqual([])
    expect(store.state.snapshots.map((s) => s.version)).toEqual([1, 2])
    expect(store.state.snapshots.map((s) => s.digest)).toEqual(digestsBefore)
    expect(store.compareTargets(v1.id, v2.id)).toEqual(diffBefore)
  })

  it('工程 JSON 往返后摘要校验、版本关系与差异结果保持一致', async () => {
    const { v1, v2 } = await setupAndExport()
    const diffBefore = store.compareTargets(v1.id, v2.id)
    const digestsBefore = store.state.snapshots.map((s) => s.digest)

    // 导出 → 序列化 → 清空 → 导入
    const json = JSON.stringify(store.buildProjectExport())
    await store.clearAll(false)
    expect(store.state.snapshots.length).toBe(0)
    const { partialOrderOk } = await store.importProjectData(JSON.parse(json))
    expect(partialOrderOk).toBe(true)

    // 摘要校验通过、版本关系保持、差异结果一致
    expect(store.state.snapshotIssues).toEqual([])
    expect(store.state.snapshots.map((s) => s.version)).toEqual([1, 2])
    expect(store.state.snapshots.map((s) => s.digest)).toEqual(digestsBefore)
    expect(store.state.snapshots[1].prevDigest).toBe(store.state.snapshots[0].digest)
    expect(store.compareTargets(v1.id, v2.id)).toEqual(diffBefore)

    // 再刷新仍一致；版本继续递增
    await store.refresh()
    expect(store.state.snapshotIssues).toEqual([])
    expect(store.compareTargets(v1.id, v2.id)).toEqual(diffBefore)
    const r3 = await store.publishSnapshot('第三版')
    expect(r3.snapshot!.version).toBe(3)
  })

  it('篡改数据库中的快照内容能被识别', async () => {
    const { v1 } = await setupAndExport()
    const stored = (await db.snapshots.get(v1.id))!
    const tampered = JSON.parse(JSON.stringify(stored)) as typeof stored
    tampered.relations[0].note = '篡改过的备注'
    await db.snapshots.put(tampered)
    await store.refresh()
    expect(store.state.snapshotIssues.some((m) => m.includes('v1'))).toBe(true)
  })

  it('删除中间快照会破坏版本链并被识别', async () => {
    const { v1 } = await setupAndExport()
    await db.snapshots.delete(v1.id)
    await store.refresh()
    expect(store.state.snapshotIssues.length).toBeGreaterThan(0)
  })

  it('篡改导出文件中的快照内容能被识别', async () => {
    await setupAndExport()
    const parsed = JSON.parse(JSON.stringify(store.buildProjectExport()))
    parsed.snapshots[0].units[0].note = '篡改'
    await store.clearAll(false)
    await store.importProjectData(parsed)
    expect(store.state.snapshotIssues.length).toBeGreaterThan(0)
  })
})
