import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { listRulePacks } from './db.js';

/** 自定义规则包落盘目录（Docker 内指入数据卷） */
const customRulesDir = config.customRulesDir;
export const builtinRulesDir = path.join(config.rulesDir, 'security');

/** 递归收集目录下所有 .yaml 规则文件（排序保证稳定） */
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

/** 目录式（可移植格式）规则包的落盘目录 */
export function customPackDir(packId: string): string {
  return path.join(customRulesDir, packId);
}

export function packFilePath(pack: { id: string; builtin: boolean }): string {
  return pack.builtin
    ? path.join(builtinRulesDir, `${pack.id.replace(/^builtin-/, '')}.yaml`)
    : customPackPath(pack.id);
}

/** 规则包参与扫描的全部规则文件：目录包取 rules/ 下所有 YAML，单文件包取自身 */
export function packRuleFiles(pack: { id: string; builtin: boolean }): string[] {
  if (pack.builtin) {
    const file = packFilePath(pack);
    return fs.existsSync(file) ? [file] : [];
  }
  const dir = customPackDir(pack.id);
  if (fs.existsSync(dir)) return collectRuleFiles(path.join(dir, 'rules'));
  const file = customPackPath(pack.id);
  return fs.existsSync(file) ? [file] : [];
}

/**
 * 启动时报告自定义规则包「文件 ↔ 数据库记录」对不上的两类残骸（只报不删，删除交给人）。
 *
 * - 有文件没记录：常见于用 DATA_DIR 起临时实例（单测、验证实例）时，库随临时目录消失、
 *   文件仍写在同一份 customRulesDir 里；换过数据目录备份也会留下。它们不参与任何扫描，只占盘。
 * - 有记录没文件：界面上还能勾选，但 packRuleFiles 返回空、扫描时被静默跳过，
 *   报告里的规则集会比用户以为的少，必须让人看见。
 */
export function reportCustomPackDrift(): void {
  if (!fs.existsSync(customRulesDir)) return;
  const custom = listRulePacks().filter((pack) => !pack.builtin);
  const known = new Set(custom.map((pack) => pack.id));
  const orphans = new Set<string>();
  for (const entry of fs.readdirSync(customRulesDir, { withFileTypes: true })) {
    // 单文件包是 <id>.yaml，目录包是 <id>/；其余文件名（打包中间产物等）不当规则包看
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
