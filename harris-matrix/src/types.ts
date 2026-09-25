/** 层位类型：堆积 / 切割 / 填充 / 界面 */
export type UnitType = 'deposit' | 'cut' | 'fill' | 'interface' | 'other'

/** 关系种类：earlier = 有向先后（from 早于 to）；contemporary = 同期关联（不进入有向图） */
export type RelationKind = 'earlier' | 'contemporary'

/** 关系来源：原始观察 / 推断 */
export type RelationSource = 'observation' | 'inference'

export type RelationStatus = 'active' | 'retracted'

/** 地层身份：与画布位置完全分离 */
export interface StratUnit {
  id: string
  label: string
  type: UnitType
  note: string
  createdAt: number
}

/** 画布位置：独立成表，删除/修改不影响地层身份 */
export interface UnitPosition {
  unitId: string
  x: number
  y: number
}

export interface Relation {
  id: string
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  status: RelationStatus
  /** 与既有记录构成环时被标记为矛盾记录（仍保留为证据） */
  conflict: boolean
  evidenceIds: string[]
  note: string
  createdAt: number
}

/** 原始证据：日记页码、照片号、剖面图编号等，仅保存在本地 IndexedDB */
export interface Evidence {
  id: string
  ref: string
  text: string
  createdAt: number
}

/** 被撤销的判断：单独成表保存快照与理由，不混入活跃关系 */
export interface Retraction {
  id: string
  relationId: string
  snapshot: Relation
  reason: string
  at: number
}

export type TableName = 'units' | 'positions' | 'relations' | 'evidences' | 'retractions'

/** 通用变更记录：before/after 支持正向应用与逆向撤销 */
export interface Mutation {
  table: TableName
  key: string
  before: unknown | null
  after: unknown | null
}

/** 一批操作（可整体撤销） */
export interface Batch {
  id: string
  label: string
  at: number
  undone: boolean
  mutations: Mutation[]
}

export interface RelationDraft {
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  evidenceIds: string[]
  note: string
}

/** 快照承载的完整工程内容：发布时刻的层位、位置、全部关系（含撤回/冲突状态） */
export interface SnapshotContent {
  app: 'harris-matrix-workbench'
  contentVersion: 1
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
  /** 活跃“早于”关系的偏序闭包（发布时计算并冻结，导入后可重算比对） */
  partialOrder: string[]
}

/**
 * 只读发布快照：单调版本号、说明与内容摘要（digest）。
 * 一经写入，应用层不再提供任何覆写或删除路径；派生工作区也只重建工作区表，绝不触碰本表。
 */
export interface Snapshot {
  /** 单调版本号，从 1 开始，在发布事务内取 max+1 */
  version: number
  /** 发布说明 */
  note: string
  publishedAt: number
  /** 发布时工作区所基于的快照版本；null 表示从独立工作区发布 */
  derivedFromVersion: number | null
  /** 发布链上的上一版本号；首版为 null */
  parentVersion: number | null
  /** 内容指纹 sha256(规范化 JSON(content))，篡改内容即可被识别 */
  digest: string
  content: SnapshotContent
}

/** meta 表键：当前工作区的派生基线 */
export type MetaKey = 'workspaceBase'

export interface MetaRecord {
  key: MetaKey
  /** 当前工作区派生自哪个快照；null 表示未基于任何快照 */
  value: number | null
  /** 最近一次发布或派生的时间 */
  at: number | null
}

/** 导出文件格式：携带偏序闭包与已发布快照，用于导入校验 */
export interface ProjectExport {
  app: 'harris-matrix-workbench'
  version: 1
  exportedAt: string
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
  /** 活跃“早于”关系的可达对闭包（排序后），导入时重算比对 */
  partialOrder: string[]
  /** 已发布快照链（旧文件可能缺省）；每条摘要随文件往返，导入后逐条复验 */
  snapshots?: Snapshot[]
  /** 当前工作区的派生基线（旧文件可能缺省） */
  workspaceBase?: number | null
}
