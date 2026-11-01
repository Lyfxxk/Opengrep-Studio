export interface IProject {
  id: string
  name: string
  description?: string
  language?: string
  languageStats?: Record<string, number>
  createdAt: string
  baselineScanId?: string
  configId?: string
  hasSource?: boolean
}

export const MOCK_PROJECTS: IProject[] = [
  {
    id: '1',
    name: '订单服务重构',
    description: '核心订单模块安全审计',
    createdAt: '2024-03-10T09:00:00Z',
    baselineScanId: '1'
  },
  {
    id: '2',
    name: '用户中心前端',
    description: 'React组件库漏洞扫描',
    createdAt: '2024-03-12T14:30:00Z'
  },
  {
    id: '3',
    name: '支付网关SDK',
    description: '第三方支付接口安全检测',
    createdAt: '2024-03-15T11:20:00Z'
  }
]
