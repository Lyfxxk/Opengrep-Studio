import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-rulelab-cleanup-'));
process.env.DATA_DIR = tempDataDir;
process.env.CUSTOM_RULES_DIR = path.join(tempDataDir, 'rules-custom');

const { cleanupRuleLabScratch } = await import('../src/rule-lab.ts');
const { closeDatabase } = await import('../src/db.ts');
const { trackTempDir } = await import('./temp-dir.mjs');
trackTempDir(tempDataDir, closeDatabase);

const scratchRoot = path.join(tempDataDir, 'rulelab');

function makeLabDir(name, ageMs = 0) {
  const dir = path.join(scratchRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rule.yaml'), 'rules: []\n', 'utf8');
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, past, past);
  }
  return dir;
}

test('刚建好的实验室目录（引擎即将读取）保留不动', () => {
  const fresh = makeLabDir('lab-fresh');
  cleanupRuleLabScratch();
  assert.ok(fs.existsSync(path.join(fresh, 'rule.yaml')), '进行中实验的 rule.yaml 不应被启动清理删掉');
});

test('超过保留期的 lab-* 残留被清掉，且可重复执行（幂等）', () => {
  makeLabDir('lab-stale', 11 * 60 * 1000);
  cleanupRuleLabScratch();
  cleanupRuleLabScratch();
  assert.ok(!fs.existsSync(path.join(scratchRoot, 'lab-stale')), '崩溃残留应在启动时清理');
});

test('非 lab- 前缀的条目不当实验室临时目录看，一律不碰', () => {
  const keep = path.join(scratchRoot, 'keep.txt');
  fs.writeFileSync(keep, 'x', 'utf8');
  cleanupRuleLabScratch();
  assert.ok(fs.existsSync(keep), '启动清理只认 lab-* 前缀');
});

test('rulelab 根目录不存在时清理是无害的空操作', () => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  assert.doesNotThrow(() => cleanupRuleLabScratch());
});
