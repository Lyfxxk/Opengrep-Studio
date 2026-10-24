export interface IConfig {
  id: string
  name: string
  description?: string
  rulePackIds: string[]
  excludes: string[]
  includes: string[]
  timeoutSeconds: number
  jobs: number
  maxTargetBytes: number
  createdAt: string
}

/** 演示模式（VITE_USE_MOCK）的种子扫描配置 */
export const MOCK_CONFIGS: IConfig[] = [
  {
    id: 'cfg-1',
    name: '默认全量配置',
    description: '勾选主要语言的内置规则包，适合首次体检',
    rulePackIds: ['builtin-python', 'builtin-js-ts', 'builtin-java'],
    excludes: [],
    includes: [],
    timeoutSeconds: 30,
    jobs: 4,
    maxTargetBytes: 5000000,
    createdAt: '2024-03-09T08:00:00Z',
  },
  {
    id: 'cfg-2',
    name: '前端专项配置',
    description: '只扫 JS/TS，排除构建产物',
    rulePackIds: ['builtin-js-ts'],
    excludes: ['dist'],
    includes: [],
    timeoutSeconds: 15,
    jobs: 2,
    maxTargetBytes: 1000000,
    createdAt: '2024-03-10T08:00:00Z',
  },
]
