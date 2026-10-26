import fs from 'node:fs';
import path from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

/**
 * 可移植规则包格式（目录约定 + 清单，与 opengrep/semgrep 生态保持互操作）：
 *   pack.yaml            清单（必填 name / version，其余推荐）
 *   rules/*.yaml         普通 opengrep 规则文件，零转换可传给引擎
 *   samples/<rule-id>/   该规则的正例 positive.<ext> 与反例 negative.<ext>
 * 测试结果是 CI / 质量检查派生的，不入包。
 */

export interface PackManifest {
  name: string;
  version: string;
  description?: string;
  descriptionEn?: string;
  author?: string;
  license?: string;
  frameworks: string[];
  cwe: string[];
  owasp: string[];
  changelog?: string;
}

export interface SampleSet {
  positives: string[];
  negatives: string[];
}

function asStringArray(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, max);
}

/** 解析并校验 pack.yaml 清单，失败抛 Error（由调用方决定映射成什么响应） */
export function parsePackManifest(text: string): PackManifest {
  let doc: unknown;
  try {
    doc = yamlLoad(text);
  } catch (error) {
    throw new Error(`pack.yaml 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error('pack.yaml 顶层必须是键值映射');
  }
  const raw = doc as Record<string, unknown>;
  const name = String(raw.name ?? '').trim();
  if (!name) throw new Error('pack.yaml 缺少 name 字段');
  if (name.length > 60) throw new Error('pack.yaml 的 name 不能超过 60 个字符');
  const version = String(raw.version ?? '').trim();
  if (!version) throw new Error('pack.yaml 缺少 version 字段');
  if (version.length > 30) throw new Error('pack.yaml 的 version 不能超过 30 个字符');
  const manifest: PackManifest = {
    name,
    version,
    frameworks: asStringArray(raw.frameworks),
    cwe: asStringArray(raw.cwe),
    owasp: asStringArray(raw.owasp),
  };
  if (typeof raw.description === 'string' && raw.description.trim()) {
    manifest.description = raw.description.trim().slice(0, 500);
  }
  if (typeof raw.descriptionEn === 'string' && raw.descriptionEn.trim()) {
    manifest.descriptionEn = raw.descriptionEn.trim().slice(0, 500);
  }
  if (typeof raw.author === 'string' && raw.author.trim()) {
    manifest.author = raw.author.trim().slice(0, 100);
  }
  if (typeof raw.license === 'string' && raw.license.trim()) {
    manifest.license = raw.license.trim().slice(0, 60);
  }
  if (typeof raw.changelog === 'string' && raw.changelog.trim()) {
    manifest.changelog = raw.changelog.trim().slice(0, 2000);
  }
  return manifest;
}


function isSampleKind(basename: string, kind: 'positive' | 'negative'): boolean {
  const firstToken = basename.split('.')[0].toLowerCase();
  return firstToken === kind;
}

/**
 * 扫描包的 samples/ 目录，按规则 id 归组样本文件。
 * 只有目录名命中已知规则 id 的样本才计入（未知目录忽略）。
 */
export function scanPackSamples(
  packDir: string,
  knownRuleIds: Set<string>,
): { byRule: Map<string, SampleSet>; sampleCount: number } {
  const byRule = new Map<string, SampleSet>();
  const samplesRoot = path.join(packDir, 'samples');
  let sampleCount = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(samplesRoot, { withFileTypes: true });
  } catch {
    return { byRule, sampleCount };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !knownRuleIds.has(entry.name)) continue;
    const ruleDir = path.join(samplesRoot, entry.name);
    const set: SampleSet = { positives: [], negatives: [] };
    const walk = (current: string) => {
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        const full = path.join(current, child.name);
        if (child.isDirectory()) walk(full);
        else if (child.isFile()) {
          if (isSampleKind(child.name, 'positive')) set.positives.push(full);
          else if (isSampleKind(child.name, 'negative')) set.negatives.push(full);
        }
      }
    };
    walk(ruleDir);
    if (set.positives.length > 0 || set.negatives.length > 0) {
      byRule.set(entry.name, set);
      sampleCount += set.positives.length + set.negatives.length;
    }
  }
  return { byRule, sampleCount };
}

/** 读取一个样本文件内容（超限截断，防止单样本拖垮引擎） */
export function readSampleText(file: string): string {
  const stat = fs.statSync(file);
  const maxBytes = 200 * 1024;
  if (stat.size > maxBytes) {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      fs.readSync(fd, buffer, 0, maxBytes, 0);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }
  return fs.readFileSync(file, 'utf8');
}

/** 旧式单文件包导出时自动生成清单（无样本，basic 档） */
export function buildLegacyManifestYaml(pack: {
  name: string;
  createdAt: string;
}): string {
  return yamlDump({
    name: pack.name,
    version: '0.1.0',
    author: 'Opengrep Studio 本地创建',
    license: 'UNLICENSED',
    changelog: `0.1.0 - 导出于 ${pack.createdAt}`,
  });
}

/** 包 README 的清单/规则信息（结构化入参，避免与 db 类型耦合） */
export interface PackReadmeInput {
  name: string;
  version?: string;
  description?: string;
  descriptionEn?: string;
  author?: string;
  license?: string;
  frameworks?: string[];
  cwe?: string[];
  owasp?: string[];
  changelog?: string;
  language?: string;
  ruleCount: number;
  /** 逐规则的样本计数（单文件包/无样本包传空数组） */
  inventory: Array<{ ruleId: string; positiveCount: number; negativeCount: number }>;
  lastCheck?: {
    tier: 'verified' | 'basic';
    passed: number;
    failed: number;
    errors: number;
    unverified: number;
    checkedAt: string;
  } | null;
}

function orDash(items: string[] | undefined): string {
  const clean = (items ?? []).filter(Boolean);
  return clean.length > 0 ? clean.join('、') : '—';
}

/**
 * 生成贡献规范风格的包 README（P1-7）：
 * 清单摘要 + 规则清单（含样本数）+ 引擎用法 + 质量状态 + 来源/许可声明。
 * 导出 zip 时若包内没有手写 README 则注入，手写的优先。
 */
export function buildPackReadme(pack: PackReadmeInput): string {
  const lines: string[] = [];
  lines.push(`# ${pack.name}`);
  lines.push('');
  if (pack.description) {
    lines.push(`> ${pack.description}`);
    lines.push('');
  }
  if (pack.descriptionEn) {
    lines.push(`> ${pack.descriptionEn}`);
    lines.push('');
  }

  lines.push('- **版本**:' + ` ${pack.version ?? '未声明'}`);
  lines.push(`- **作者**: ${pack.author ?? '未声明'}`);
  lines.push(`- **许可**: ${pack.license ?? '未声明（分发前请在 pack.yaml 中明确）'}`);
  if (pack.language) lines.push(`- **适用语言**: ${pack.language}`);
  lines.push(`- **适用框架**: ${orDash(pack.frameworks)}`);
  lines.push(`- **CWE**: ${orDash(pack.cwe)}`);
  lines.push(`- **OWASP**: ${orDash(pack.owasp)}`);
  lines.push('');

  lines.push(`## 规则清单（共 ${pack.ruleCount} 条）`);
  lines.push('');
  if (pack.inventory.length > 0) {
    lines.push('| 规则 ID | 正例样本 | 反例样本 |');
    lines.push('|---|---|---|');
    for (const item of pack.inventory) {
      lines.push(`| \`${item.ruleId}\` | ${item.positiveCount} | ${item.negativeCount} |`);
    }
  } else {
    lines.push('本包未随附逐规则样本清单（可移植目录包会在 samples/ 下按规则归组样本）。');
  }
  lines.push('');

  lines.push('## 使用方法');
  lines.push('');
  lines.push('```bash');
  lines.push('# rules/ 下是普通 opengrep 规则文件，可直接交给引擎');
  lines.push('opengrep scan --config rules/ --json <目标目录>');
  lines.push('```');
  lines.push('');
  lines.push(
    '或在 [Opengrep Studio](https://github.com/Lyfxxk/Opengrep-Studio) 的工作台中：配置管理 → 规则包 → 导入规则包（本 zip 可直接导入）。',
  );
  lines.push('');

  lines.push('## 质量状态');
  lines.push('');
  if (pack.lastCheck) {
    lines.push(
      `最近一次样本回归（${pack.lastCheck.checkedAt}）：通过 ${pack.lastCheck.passed} · 未通过 ${pack.lastCheck.failed} · 错误 ${pack.lastCheck.errors} · 无样本 ${pack.lastCheck.unverified} —— 判定 **${pack.lastCheck.tier}** 档。`,
    );
  } else {
    const sampleTotal = pack.inventory.reduce(
      (sum, item) => sum + item.positiveCount + item.negativeCount,
      0,
    );
    lines.push(
      sampleTotal > 0
        ? `本包随附 ${sampleTotal} 个测试样本；导入后可在规则包页一键质量检查回归。`
        : '本包未随附测试样本（basic 档）；欢迎按"正例命中、反例无误报"补充样本后提 PR。',
    );
  }
  lines.push('');
  lines.push('测试结果不入包：按可移植规则包规范，样本是事实源，验证结果由 CI / 质量检查从 samples/ 派生。');
  lines.push('');

  lines.push('## 来源与许可声明');
  lines.push('');
  if (pack.changelog) {
    lines.push(`变更记录：${pack.changelog}`);
    lines.push('');
  }
  lines.push(
    `本规则包按 pack.yaml 声明的许可（${pack.license ?? '见 pack.yaml'}）分发。规则为原创或已注明上游来源；`,
  );
  lines.push(
    '**不得包含来自 [semgrep-rules](https://github.com/semgrep/semgrep-rules) 的规则**（其许可独立于引擎并限制竞争性使用）。',
  );
  lines.push('打包规范与许可红线以 pack.yaml 及以上声明为准。');
  lines.push('');
  return lines.join('\n');
}
