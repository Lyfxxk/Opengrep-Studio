// 兜底扫描配置回归（node --test 运行，`npm test` 统一驱动）
// 锁住三件事：未绑定配置的项目扫描永远有配置可用（创建/接管/掏空自愈）、它是幂等的且不改主键、
// 没有任何可用内置包时如实返回 undefined（而不是建一条扫不出结果的空配置）。
// DATA_DIR 必须在动态导入 config/db 之前指向临时目录，单测不碰 server/data/ 的真实库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'og-fallback-cfg-'));

const db = await import('../src/db.ts');
const { ensureFallbackScanConfig } = await import('../src/fallback-config.ts');

const now = () => new Date().toISOString();

function seedPack(id, { builtin = true, enabled = true } = {}) {
  db.insertRulePack({
    id,
    name: id,
    language: 'python',
    builtin,
    enabled,
    ruleCount: 1,
    createdAt: now(),
  });
}

/** 每个用例从空表开始：兜底配置的身份由 configs 表内容决定，残留会串味 */
function resetTables() {
  for (const config of db.listConfigs()) db.deleteConfig(config.id);
  for (const pack of db.listRulePacks()) db.deleteRulePack(pack.id);
}

test('首启创建兜底配置：只收已启用的内置包、带保护标记，重复调用不再建第二条', () => {
  resetTables();
  seedPack('rp-a');
  seedPack('rp-b');
  seedPack('rp-off', { enabled: false });
  seedPack('rp-custom', { builtin: false });

  const config = ensureFallbackScanConfig();
  assert.equal(config?.id, 'cfg-fallback');
  assert.equal(config?.isProtected, true);
  // listRulePacks 按 builtin/created_at/id 排序，断言只关心集合本身
  assert.deepEqual([...config.rulePackIds].sort(), ['rp-a', 'rp-b'], '停用的内置包与自定义包都不该进兜底规则集');

  const again = ensureFallbackScanConfig();
  assert.equal(again?.id, 'cfg-fallback');
  assert.equal(db.listConfigs().length, 1, '重复调用必须幂等');
});

test('没有任何已启用内置包时返回 undefined，且不留下空配置', () => {
  resetTables();
  seedPack('rp-off', { enabled: false });
  seedPack('rp-custom', { builtin: false });

  assert.equal(ensureFallbackScanConfig(), undefined);
  assert.equal(db.listConfigs().length, 0);
});

test('旧库里同名的一键扫描配置被就地接管：主键不变、不产生第二条、过时说明被换掉', () => {
  resetTables();
  seedPack('rp-a');
  db.insertConfig({
    id: 'cfg-old',
    name: '默认扫描配置',
    description: '一键扫描自动创建：全部启用的内置规则包，可在扫描配置页调整',
    rulePackIds: ['rp-a'],
    excludes: ['node_modules'],
    includes: [],
    timeoutSeconds: 10,
    jobs: 8,
    maxTargetBytes: 2000000,
    createdAt: now(),
  });

  const adopted = ensureFallbackScanConfig();
  assert.equal(adopted?.id, 'cfg-old', '接管不能改主键，否则项目绑定会集体失效');
  assert.equal(adopted?.isProtected, true);
  assert.equal(adopted?.timeoutSeconds, 10, '用户调过的引擎参数必须原样保留');
  assert.deepEqual(adopted?.excludes, ['node_modules']);
  assert.notEqual(adopted?.description, '一键扫描自动创建：全部启用的内置规则包，可在扫描配置页调整');
  assert.equal(db.listConfigs().length, 1);
  assert.equal(db.getConfig('cfg-old')?.isProtected, true, '保护标记要落库');
});

test('接管时保留用户自己写的说明', () => {
  resetTables();
  seedPack('rp-a');
  db.insertConfig({
    id: 'cfg-old',
    name: '默认扫描配置',
    description: '我自己的兜底说明',
    rulePackIds: ['rp-a'],
    excludes: [],
    includes: [],
    timeoutSeconds: 5,
    jobs: 4,
    maxTargetBytes: 1000000,
    createdAt: now(),
  });

  assert.equal(ensureFallbackScanConfig()?.description, '我自己的兜底说明');
});

test('兜底配置的规则包被删空后自愈补回，全停用则不凭空造规则集', () => {
  resetTables();
  seedPack('rp-a');
  seedPack('rp-b');
  seedPack('rp-c');
  const config = ensureFallbackScanConfig();
  assert.equal(config?.rulePackIds.length, 3);

  // 内置包文件消失被清理掉两个，第三个被用户在规则包页停用 → 规则集实际可用项归零
  db.deleteRulePack('rp-a');
  db.deleteRulePack('rp-b');
  db.updateRulePack('rp-c', { enabled: false });
  assert.deepEqual(db.getConfig('cfg-fallback')?.rulePackIds, ['rp-c']);

  // 一个可用内置包都没有：兜底配置保持原样，由调用方给出「先启用规则包」的指引
  assert.deepEqual(ensureFallbackScanConfig()?.rulePackIds, ['rp-c']);

  // 重新启用内置包后再解析：兜底配置补回可用规则集并落库，未绑定配置的项目才扫得动
  db.updateRulePack('rp-c', { enabled: true });
  const healed = ensureFallbackScanConfig();
  assert.deepEqual(healed?.rulePackIds, ['rp-c'], '仍有可用项时不改动用户的勾选');
  db.updateRulePack('rp-c', { enabled: false });
  seedPack('rp-new');
  assert.deepEqual(ensureFallbackScanConfig()?.rulePackIds, ['rp-new']);
  assert.deepEqual(db.getConfig('cfg-fallback')?.rulePackIds, ['rp-new'], '自愈结果要落库');
});

test('用户勾过规则的兜底配置不被覆盖（仍有可用规则包时保持原样）', () => {
  resetTables();
  seedPack('rp-a');
  seedPack('rp-b');
  const config = ensureFallbackScanConfig();
  db.updateConfig(config.id, { rulePackIds: ['rp-b'] });

  assert.deepEqual(ensureFallbackScanConfig()?.rulePackIds, ['rp-b']);
});
