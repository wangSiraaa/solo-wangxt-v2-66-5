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

/** 快照封存的内容：层位、位置、全部关系（含冲突状态）、证据与撤销记录，以及发布时的偏序闭包 */
export interface SnapshotContent {
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
  /** 发布时活跃“早于”关系的可达对闭包（排序后），用于校验与差异审查 */
  closure: string[]
}

/** 只读发布快照：版本号单调递增、绝不复用；摘要链式衔接，任何篡改都可被识别 */
export interface Snapshot extends SnapshotContent {
  id: string
  /** 单调递增版本号，从 1 开始 */
  version: number
  /** 发布说明 */
  note: string
  createdAt: number
  /** 上一快照的摘要（首个快照为空串），用于链式校验 */
  prevDigest: string
  /** 内容摘要：sha256(prevDigest + 规范化内容) */
  digest: string
}

/** 发布前的阻断原因：成环冲突 / 悬空引用 */
export interface PublishBlocker {
  kind: 'cycle' | 'dangling'
  message: string
}

/** 两版内容的差异，明确区分三类：实体变化 / 直接关系变化 / 仅由闭包推导的语义变化 */
export interface SnapshotDiff {
  /** 实体变化：层位本身的新增、移除、属性修改 */
  units: {
    added: StratUnit[]
    removed: StratUnit[]
    changed: Array<{ before: StratUnit; after: StratUnit }>
  }
  /** 画布位置的增删与移动（与地层身份分离，单列） */
  positions: {
    added: UnitPosition[]
    removed: UnitPosition[]
    moved: Array<{ unitId: string; before: UnitPosition; after: UnitPosition }>
  }
  /** 直接关系变化：关系记录本身的新增、移除、修改（含撤回、矛盾标记、证据变化） */
  relations: {
    added: Relation[]
    removed: Relation[]
    changed: Array<{ before: Relation; after: Relation }>
  }
  /** 仅由闭包推导造成的语义变化：可达对增减中不对应任何直接边的部分 */
  closure: {
    addedPairs: string[]
    removedPairs: string[]
  }
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

/** 导出文件格式：携带偏序闭包用于导入校验；携带全部已发布快照，往返后链式摘要仍可校验 */
export interface ProjectExport {
  app: 'harris-matrix-workbench'
  version: 1
  exportedAt: string
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
  /** 已发布的只读快照（含版本号与摘要链），导入时原样恢复 */
  snapshots?: Snapshot[]
  /** 活跃“早于”关系的可达对闭包（排序后），导入时重算比对 */
  partialOrder: string[]
}
