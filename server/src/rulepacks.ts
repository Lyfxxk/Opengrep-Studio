import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { listRulePacks } from './db.js';

const customRulesDir = config.customRulesDir;
export const builtinRulesDir = path.join(config.rulesDir, 'security');

export function collectRuleFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ya?ml$/i.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

export function customPackPath(packId: string): string {
  return path.join(customRulesDir, `${packId}.yaml`);
}

export function customPackDir(packId: string): string {
  return path.join(customRulesDir, packId);
}

export function packFilePath(pack: { id: string; builtin: boolean }): string {
  return pack.builtin
    ? path.join(builtinRulesDir, `${pack.id.replace(/^builtin-/, '')}.yaml`)
    : customPackPath(pack.id);
}

export function packRuleFiles(pack: { id: string; builtin: boolean }): string[] {
  if (pack.builtin) {
    const file = packFilePath(pack);
    return fs.existsSync(file) ? [file] : [];
  }
  const dir = customPackDir(pack.id);
  if (fs.existsSync(dir)) {
    const rulesStat = fs.statSync(path.join(dir, 'rules'), { throwIfNoEntry: false });
    return rulesStat?.isDirectory() ? collectRuleFiles(path.join(dir, 'rules')) : [];
  }
  const file = customPackPath(pack.id);
  return fs.existsSync(file) ? [file] : [];
}

export function reportCustomPackDrift(): void {
  if (!fs.existsSync(customRulesDir)) return;
  const custom = listRulePacks().filter((pack) => !pack.builtin);
  const known = new Set(custom.map((pack) => pack.id));
  const orphans = new Set<string>();
  for (const entry of fs.readdirSync(customRulesDir, { withFileTypes: true })) {
    const id = entry.isDirectory()
      ? entry.name
      : /\.ya?ml$/i.test(entry.name)
        ? entry.name.replace(/\.ya?ml$/i, '')
        : undefined;
    if (id && !known.has(id)) orphans.add(id);
  }
  const broken = custom.filter((pack) => packRuleFiles(pack).length === 0);
  if (orphans.size > 0) {
    const list = [...orphans];
    console.warn(
      `[server] 自定义规则包目录有 ${list.length} 项没有对应记录（不参与扫描，可手动删除）：${config.customRulesDir} → ${list.slice(0, 5).join(', ')}${list.length > 5 ? ' …' : ''}`,
    );
  }
  for (const pack of broken) {
    console.warn(
      `[server] 规则包「${pack.name}」（${pack.id}）的文件不存在，扫描会跳过它；请重新导入或在界面删除该记录`,
    );
  }
}
