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
