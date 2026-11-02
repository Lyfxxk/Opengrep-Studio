import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-fallback-cfg-'));
process.env.DATA_DIR = tempDataDir;
process.env.CUSTOM_RULES_DIR = path.join(tempDataDir, 'rules-custom');

const db = await import('../src/db.ts');
const { ensureFallbackScanConfig } = await import('../src/fallback-config.ts');
const { trackTempDir } = await import('./temp-dir.mjs');
trackTempDir(tempDataDir, db.closeDatabase);

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

  db.deleteRulePack('rp-a');
  db.deleteRulePack('rp-b');
  db.updateRulePack('rp-c', { enabled: false });
  assert.deepEqual(db.getConfig('cfg-fallback')?.rulePackIds, ['rp-c']);

  assert.deepEqual(ensureFallbackScanConfig()?.rulePackIds, ['rp-c']);

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
