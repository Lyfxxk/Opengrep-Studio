/**
 * 引擎输出归一化工具（scan-runner 全量扫描与 rule-lab 单规则实验共用）。
 */

/** 反斜杠路径分隔符统一为正斜杠（引擎在 Windows 上返回反斜杠路径） */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 把引擎返回的路径 relativize 到给定根目录（扫描源码快照 / 实验室临时目录共用）。
 * 两侧统一剥前导斜杠再比对：引擎在 Linux 上返回绝对路径（/home/...），
 * 只剥一侧会让 norm（home/...）永远匹配不上带斜杠的 prefix（/home/...）。
 */
export function relativizeToRoot(p: string, rootDir: string): string {
  const stripRoot = (s: string) => normalizePath(s).replace(/^\/+/, '');
  const norm = stripRoot(p);
  const prefix = `${stripRoot(rootDir).replace(/\/+$/, '')}/`;
  if (norm.toLowerCase().startsWith(prefix.toLowerCase())) {
    return norm.slice(prefix.length);
  }
  return norm;
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
