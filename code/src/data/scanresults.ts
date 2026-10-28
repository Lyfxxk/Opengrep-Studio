export interface IScanResult {
  id: string
  projectId: string
  status: 'scanning' | 'completed' | 'failed'
  issueCount: number
  scannedAt: string
  finishedAt?: string
  /** 本次扫描覆盖的源码文件数（旧记录可能没有） */
  fileCount?: number
  baselineScanId?: string
  rules?: string
  /** 发起扫描时实际生效的规则包快照（旧记录 / 旧式目录扫描没有） */
  rulepacks?: Array<{ id: string; name: string }>
  /** 发起扫描时的引擎版本（升级引擎后旧记录仍是当日版本） */
  engineVersion?: string
  /** 排队等待并发槽位的标记（status 为 scanning 且有值 = 排队中，开跑后清除），用于区分"排队中/扫描中" */
  queuedAt?: string
  message?: string
}

// issueCount 口径与服务端一致：不含基线对比产生的"已修复"项（见 data/issues.ts 的种子明细）
export const MOCK_SCAN_RESULTS: IScanResult[] = [
  {
    id: '1',
    projectId: '1',
    status: 'completed',
    issueCount: 1,
    scannedAt: '2024-03-10T09:30:00Z',
    baselineScanId: undefined
  },
  {
    id: '2',
    projectId: '1',
    status: 'completed',
    issueCount: 4,
    scannedAt: '2024-03-11T14:20:00Z',
    baselineScanId: '1'
  },
  {
    id: '3',
    projectId: '2',
    status: 'failed',
    issueCount: 0,
    scannedAt: '2024-03-12T10:00:00Z'
  }
]