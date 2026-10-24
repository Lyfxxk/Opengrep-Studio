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
  message?: string
}

export const MOCK_SCAN_RESULTS: IScanResult[] = [
  {
    id: '1',
    projectId: '1',
    status: 'completed',
    issueCount: 12,
    scannedAt: '2024-03-10T09:30:00Z',
    baselineScanId: undefined
  },
  {
    id: '2',
    projectId: '1',
    status: 'completed',
    issueCount: 8,
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