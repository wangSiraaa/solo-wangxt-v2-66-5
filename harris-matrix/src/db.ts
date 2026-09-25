import Dexie, { type Table } from 'dexie'
import type { Batch, Evidence, MetaRecord, Relation, Retraction, Snapshot, StratUnit, UnitPosition } from './types'

/**
 * 纯本地存储：所有现场资料只写入浏览器 IndexedDB，不发生任何网络上传。
 * 原始观察 / 推断关系（relations 表，以 source 区分）、被撤销判断（retractions 表）分开保存。
 * snapshots 表为只增不删的发布记录；meta 表记录当前工作区的派生基线。
 */
class MatrixDB extends Dexie {
  units!: Table<StratUnit, string>
  positions!: Table<UnitPosition, string>
  relations!: Table<Relation, string>
  evidences!: Table<Evidence, string>
  retractions!: Table<Retraction, string>
  batches!: Table<Batch, string>
  snapshots!: Table<Snapshot, number>
  meta!: Table<MetaRecord, string>

  constructor() {
    super('harris-matrix')
    this.version(1).stores({
      units: 'id',
      positions: 'unitId',
      relations: 'id, from, to, status',
      evidences: 'id',
      retractions: 'id, relationId',
      batches: 'id, at',
    })
    this.version(2).stores({
      units: 'id',
      positions: 'unitId',
      relations: 'id, from, to, status',
      evidences: 'id',
      retractions: 'id, relationId',
      batches: 'id, at',
      // 版本号即主键（单调递增）；publishedAt 支持按时间排序
      snapshots: 'version, publishedAt',
      meta: 'key',
    })
  }
}

export const db = new MatrixDB()
