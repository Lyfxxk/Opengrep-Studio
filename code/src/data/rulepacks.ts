interface IRulePackManifest {
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

interface IRulePackCheckSummary {
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

interface IRulePackCheckItem {
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

/** 演示模式（VITE_USE_MOCK）的种子规则包：4 个内置 + 1 个带样本的自建包 */
export const MOCK_RULE_PACKS: IRulePack[] = [
  {
    id: 'builtin-python',
    name: 'Python 内置安全规则包',
    language: 'Python',
    builtin: true,
    enabled: true,
    ruleCount: 50,
    createdAt: '2024-03-01T08:00:00Z',
  },
  {
    id: 'builtin-js-ts',
    name: 'JavaScript / TypeScript 内置安全规则包',
    language: 'JavaScript / TypeScript',
    builtin: true,
    enabled: true,
    ruleCount: 50,
    createdAt: '2024-03-01T08:00:00Z',
  },
  {
    id: 'builtin-java',
    name: 'Java 内置安全规则包',
    language: 'Java',
    builtin: true,
    enabled: true,
    ruleCount: 50,
    createdAt: '2024-03-01T08:00:00Z',
  },
  {
    id: 'builtin-go',
    name: 'Go 内置安全规则包',
    language: 'Go',
    builtin: true,
    enabled: false,
    ruleCount: 50,
    createdAt: '2024-03-01T08:00:00Z',
  },
  {
    id: 'rp-demo-eval',
    name: '演示自建包（含样本）',
    language: 'JavaScript',
    builtin: false,
    enabled: true,
    ruleCount: 1,
    createdAt: '2024-03-05T09:30:00Z',
    version: '1.0.0',
    isDir: true,
    sampleCount: 2,
    manifest: {
      name: '演示自建包（含样本）',
      version: '1.0.0',
      description: 'eval 动态执行检测，附正反例样本',
      license: 'MIT',
    },
  },
]
