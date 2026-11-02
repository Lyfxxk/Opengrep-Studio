import { load as yamlLoad } from 'js-yaml';

export class RuleYamlError extends Error {
  constructor(
    public code: string,
    message: string,
    public params?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function invalid(
  index: number,
  reason: string,
  code: string,
  params: Record<string, unknown> = {},
): never {
  throw new RuleYamlError(code, `规则条目不合法（第 ${index + 1} 条：${reason}）`, {
    index: index + 1,
    ...params,
  });
}

export function parseRuleYaml(text: string): {
  ruleCount: number;
  ruleIds: string[];
  firstLanguage: string;
} {
  let doc: unknown;
  try {
    doc = yamlLoad(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RuleYamlError('ruleYaml.parseFailed', `YAML 解析失败：${reason}`, { reason });
  }
  const rules = (doc as { rules?: unknown[] } | null)?.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new RuleYamlError('ruleYaml.rulesMissing', 'YAML 顶层需要非空的 rules 列表');
  }
  const ruleIds: string[] = [];
  let firstLanguage = '';
  rules.forEach((rule, index) => {
    const item = (
      typeof rule === 'object' && rule !== null ? rule : {}
    ) as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) {
      invalid(index, '缺少 id', 'ruleYaml.missingId');
    }
    if (!Array.isArray(item.languages) || item.languages.length === 0) {
      invalid(index, `规则 ${id} 缺少 languages`, 'ruleYaml.missingLanguages', { id });
    }
    if (!firstLanguage && typeof (item.languages as unknown[])[0] === 'string') {
      firstLanguage = String((item.languages as unknown[])[0]);
    }
    const hasPattern =
      item.mode === 'taint' ||
      Object.keys(item).some((key) => key.startsWith('pattern'));
    if (!hasPattern) {
      invalid(index, `规则 ${id} 缺少 pattern 类表达式或 taint 模式声明`, 'ruleYaml.missingPattern', {
        id,
      });
    }
    ruleIds.push(id);
  });
  const duplicate = ruleIds.find((id, index) => ruleIds.indexOf(id) !== index);
  if (duplicate) {
    throw new RuleYamlError('ruleYaml.duplicateId', `存在重复的规则 id：${duplicate}`, {
      id: duplicate,
    });
  }
  return { ruleCount: ruleIds.length, ruleIds, firstLanguage };
}
