// 规则包一键回归（P1-1）：校验内置 + 自定义规则包的 YAML 结构，
// 对随包样本（samples/<rule-id>/）逐规则跑正反例回归（复用质量检查链路，spawn 真实引擎）。
//
// 用法：
//   npm run test-packs            # 人读输出；任何结构错误或样本回归 fail/error 时非零退出
//   npm run test-packs -- --json  # 机器可读输出（CI 用）
//
// 说明：内置包（server/rules/security/）当前不随仓库分发样本，只做结构校验（basic 档）；
// 自定义目录包（server/rules/custom/<id>/）带样本时才 spawn 引擎，无引擎且无样本也能跑完。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.ts';
import { parseRuleYaml } from '../src/rule-yaml.ts';
import { runPackCheck } from '../src/rule-lab.ts';
import { parsePackManifest } from '../src/pack-format.ts';
import { collectRuleFiles } from '../src/rulepacks.ts';

const builtinDir = path.join(config.rulesDir, 'security');
const customDir = config.customRulesDir; // 尊重 CUSTOM_RULES_DIR（Docker 数据卷）配置
const asJson = process.argv.includes('--json');

function collectPacks() {
  const packs = [];
  if (existsSync(builtinDir)) {
    for (const entry of readdirSync(builtinDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        packs.push({
          id: `builtin-${entry.name.replace(/\.ya?ml$/i, '')}`,
          name: entry.name,
          kind: 'builtin',
          dir: null,
          file: path.join(builtinDir, entry.name),
        });
      }
    }
  }
  if (existsSync(customDir)) {
    for (const entry of readdirSync(customDir, { withFileTypes: true })) {
      const full = path.join(customDir, entry.name);
      if (entry.isDirectory()) {
        packs.push({ id: entry.name, name: entry.name, kind: 'dir', dir: full, file: null });
      } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        packs.push({ id: entry.name.replace(/\.ya?ml$/i, ''), name: entry.name, kind: 'single', dir: null, file: full });
      }
    }
  }
  return packs;
}

function structuralCheck(pack) {
  // 返回 { ruleCount, errors: string[] }
  const errors = [];
  let ruleCount = 0;
  if (pack.kind === 'dir') {
    const manifestFile = path.join(pack.dir, 'pack.yaml');
    if (!existsSync(manifestFile)) {
      errors.push('缺少 pack.yaml 清单');
    } else {
      try {
        parsePackManifest(readFileSync(manifestFile, 'utf8'));
      } catch (error) {
        errors.push(`pack.yaml 不合法：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // collectRuleFiles 对不存在/不是目录的 rules/ 会直接抛 ENOENT/ENOTDIR：
    // 目录包漂移（用户手工删了 rules/）时这里要报成结构错误，而不是让整个回归脚本崩掉
    let ruleFiles = [];
    try {
      ruleFiles = collectRuleFiles(path.join(pack.dir, 'rules'));
    } catch (error) {
      errors.push(`rules/ 目录不可读：${error instanceof Error ? error.message : String(error)}`);
    }
    if (ruleFiles.length === 0 && errors.length === 0) {
      errors.push('rules/ 目录没有任何 YAML 规则文件');
    }
    for (const file of ruleFiles) {
      try {
        ruleCount += parseRuleYaml(readFileSync(file, 'utf8')).ruleCount;
      } catch (error) {
        errors.push(
          `${path.relative(pack.dir, file)} 不合法：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } else {
    try {
      ruleCount = parseRuleYaml(readFileSync(pack.file, 'utf8')).ruleCount;
    } catch (error) {
      errors.push(`YAML 不合法：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ruleCount, errors };
}

const packs = collectPacks();
const results = [];
let totalRules = 0;

for (const pack of packs) {
  const record = {
    id: pack.id,
    name: pack.name,
    kind: pack.kind,
    ruleCount: 0,
    tier: 'basic',
    structuralErrors: [],
    sampled: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    unverified: 0,
    details: [],
  };
  const structural = structuralCheck(pack);
  record.ruleCount = structural.ruleCount;
  record.structuralErrors = structural.errors;
  totalRules += structural.ruleCount;

  // 只有可移植目录包带逐规则样本；内置/单文件包只做结构校验（无样本 → unverified/basic）
  if (pack.kind === 'dir' && structural.errors.length === 0) {
    try {
      const check = await runPackCheck(pack.dir);
      record.tier = check.tier;
      for (const item of check.items) {
        if (item.verdict === 'pass') record.passed += 1;
        else if (item.verdict === 'fail') record.failed += 1;
        else if (item.verdict === 'error') record.errored += 1;
        else record.unverified += 1;
        if (item.verdict === 'fail' || item.verdict === 'error') {
          record.sampled += 1;
          record.details.push(`${item.ruleId}: ${item.verdict} — ${item.detail ?? '未通过'}`);
        }
      }
    } catch (error) {
      record.structuralErrors.push(
        `样本回归失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const ok =
    record.structuralErrors.length === 0 && record.failed === 0 && record.errored === 0;
  results.push({ ...record, ok });
}

const summary = {
  packs: results.length,
  rules: totalRules,
  ok: results.filter((r) => r.ok && r.tier === 'verified').length,
  basic: results.filter((r) => r.ok && r.tier === 'basic').length,
  failed: results.filter((r) => !r.ok).length,
};

if (asJson) {
  console.log(JSON.stringify({ summary, packs: results }, null, 2));
} else {
  console.log(`[test-packs] 规则包回归：${summary.packs} 个包 / ${summary.rules} 条规则`);
  for (const r of results) {
    const mark = r.ok ? '✓' : '✗';
    const note =
      r.kind === 'dir'
        ? `${r.tier} 档（通过 ${r.passed} · 未通过 ${r.failed} · 错误 ${r.errored} · 无样本 ${r.unverified}）`
        : 'basic（无随包样本，仅结构校验）';
    console.log(`  ${mark} ${r.id}  ${r.ruleCount} 条规则 · ${note}`);
    for (const line of r.structuralErrors) console.log(`      结构错误: ${line}`);
    for (const line of r.details) console.log(`      ${line}`);
  }
  console.log(
    `[test-packs] 汇总：verified ${summary.ok} · basic ${summary.basic} · 失败 ${summary.failed}`,
  );
  console.log(summary.failed === 0 ? '[test-packs] 全部通过 ✔' : `[test-packs] ${summary.failed} 个包未通过 ✘`);
}

process.exit(summary.failed === 0 ? 0 : 1);
