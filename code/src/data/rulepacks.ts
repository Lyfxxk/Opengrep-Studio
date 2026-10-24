export interface IRulePackManifest {
  name: string;
  version: string;
  description?: string;
  descriptionEn?: string;
  author?: string;
  license?: string;
  frameworks?: string[];
  cwe?: string[];
  owasp?: string[];
  changelog?: string;
}

export interface IRulePackCheckSummary {
  tier: 'verified' | 'basic';
  passed: number;
  failed: number;
  errors: number;
  unverified: number;
  checkedAt: string;
}

export interface IRulePack {
  id: string
  name: string
  language: string
  builtin: boolean
  enabled: boolean
  ruleCount: number
  createdAt: string
  /** 可移植格式清单（目录包必有；单文件包为 null） */
  version?: string
  manifest?: IRulePackManifest | null
  /** 样本文件总数（正例 + 反例） */
  sampleCount?: number
  /** 目录式包（可移植格式） */
  isDir?: boolean
  /** 最近一次质量检查摘要 */
  lastCheck?: IRulePackCheckSummary | null
}

export interface IRulePackCheckItem {
  ruleId: string;
  ruleFile: string;
  positiveCount: number;
  negativeCount: number;
  verdict: 'pass' | 'fail' | 'error' | 'unverified';
  detail?: string;
}

export interface IRulePackCheckResult {
  tier: 'verified' | 'basic';
  items: IRulePackCheckItem[];
  durationMs: number;
  summary: IRulePackCheckSummary;
}
