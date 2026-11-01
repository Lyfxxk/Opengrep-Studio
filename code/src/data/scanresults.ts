export interface IScanResult {
  id: string
  projectId: string
  status: 'scanning' | 'completed' | 'failed'
  issueCount: number
  scannedAt: string
  startedAt?: string
  finishedAt?: string
  fileCount?: number
  baselineScanId?: string
  rules?: string
  rulepacks?: Array<{ id: string; name: string }>
  engineVersion?: string
  queuedAt?: string
  message?: string
  errorCode?: string
  errorParams?: Record<string, unknown>
}

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