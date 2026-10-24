import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/** 自定义规则包落盘目录（Docker 内指入数据卷） */
export const customRulesDir = config.customRulesDir;
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
