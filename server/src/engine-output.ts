
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function relativizeToRoot(p: string, rootDir: string): string {
  const stripRoot = (s: string) => normalizePath(s).replace(/^\/+/, '');
  const norm = stripRoot(p);
  const prefix = `${stripRoot(rootDir).replace(/\/+$/, '')}/`;
  if (norm.toLowerCase().startsWith(prefix.toLowerCase())) {
    return norm.slice(prefix.length);
  }
  return norm;
}

export function stripRuleIdPrefix(checkId: string, knownRuleIds: Iterable<string>): string {
  for (const ruleId of knownRuleIds) {
    if (checkId === ruleId || checkId.endsWith(`.${ruleId}`)) return ruleId;
  }
  const parts = checkId.split('.');
  return parts[parts.length - 1];
}
