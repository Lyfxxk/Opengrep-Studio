import { load as yamlLoad } from 'js-yaml';

interface RuleYamlIssue {
  index: number;
  reason: string;
}

export function parseRuleYaml(text: string): {
  ruleCount: number;
  ruleIds: string[];
  /** 第一条规则的 languages[0]（无法推断时为空串） */
  firstLanguage: string;
} {
  let doc: unknown;
  try {
    doc = yamlLoad(text);
  } catch (error) {
    throw new Error(`YAML 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const rules = (doc as { rules?: unknown[] } | null)?.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('YAML 顶层需要非空的 rules 列表');
  }
  const ruleIds: string[] = [];
  let firstLanguage = '';
  const issues: RuleYamlIssue[] = [];
  rules.forEach((rule, index) => {
    // YAML 里 `rules: [null]`、`- 42` 这类条目不是对象：直接读 item.id 会抛 TypeError
    // （"Cannot read properties of null"），报错既不像业务错误也不带条目位置
    const item = (
      typeof rule === 'object' && rule !== null ? rule : {}
    ) as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) {
      issues.push({ index, reason: '缺少 id' });
      return;
    }
    if (!Array.isArray(item.languages) || item.languages.length === 0) {
      issues.push({ index, reason: `规则 ${id} 缺少 languages` });
      return;
    }
    if (!firstLanguage && typeof item.languages[0] === 'string') {
      firstLanguage = item.languages[0];
    }
    const hasPattern =
      item.mode === 'taint' ||
      Object.keys(item).some((key) => key.startsWith('pattern'));
    if (!hasPattern) {
      issues.push({ index, reason: `规则 ${id} 缺少 pattern 类表达式或 taint 模式声明` });
      return;
    }
    ruleIds.push(id);
  });
  if (issues.length > 0) {
    const detail = issues
      .slice(0, 3)
      .map((issue) => `第 ${issue.index + 1} 条：${issue.reason}`)
      .join('；');
    throw new Error(`规则条目不合法（${detail}${issues.length > 3 ? ' 等' : ''}）`);
  }
  if (new Set(ruleIds).size !== ruleIds.length) {
    throw new Error('存在重复的规则 id');
  }
  return { ruleCount: ruleIds.length, ruleIds, firstLanguage };
}
