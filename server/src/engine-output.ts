/**
 * 引擎输出归一化工具（scan-runner 全量扫描与 rule-lab 单规则实验共用）。
 */

/** 反斜杠路径分隔符统一为正斜杠（引擎在 Windows 上返回反斜杠路径） */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 剥离引擎 check_id 的配置路径前缀：opengrep 对目录型 --config 会给规则 id
 * 加上相对路径前缀（如 security/python/rule.yaml.python.avoid-pickle），
 * 按已知规则 id 精确/后缀匹配还原短 id，兜底取最后一段。
 */
export function stripRuleIdPrefix(checkId: string, knownRuleIds: Iterable<string>): string {
  for (const ruleId of knownRuleIds) {
    if (checkId === ruleId || checkId.endsWith(`.${ruleId}`)) return ruleId;
  }
  const parts = checkId.split('.');
  return parts[parts.length - 1];
}
