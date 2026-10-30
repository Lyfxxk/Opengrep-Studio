// 实验室临时目录清理回归（node --test 运行，`npm test` 统一驱动）
// 锁住一件事：启动清理只删超过保留期的 lab-* 残留，绝不动刚建的目录。
// 背景：rulelab 树由本服务与 pack-regression 等独立进程共用，旧实现整树 rmSync，
// 服务热重启会把回归进程正在使用的临时目录连根端掉，引擎侧报「配置文件 rule.yaml
// 不存在」，规则包回归因此假红。
// DATA_DIR 必须在动态导入 config 前指向临时目录，单测不碰 server/data/ 的真实库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-rulelab-cleanup-'));
process.env.DATA_DIR = tempDataDir;

const { cleanupRuleLabScratch } = await import('../src/rule-lab.ts');
// rule-lab → rulepacks → db 的导入链会在模块加载时打开 SQLite：退出回收必须先关库，
// 否则 Windows 上句柄未释放、rmSync 删不掉临时目录（EPERM 被 trackTempDir 吞掉又攒残目录）
const { closeDatabase } = await import('../src/db.ts');
const { trackTempDir } = await import('./temp-dir.mjs');
trackTempDir(tempDataDir, closeDatabase);

const scratchRoot = path.join(tempDataDir, 'rulelab');

/** 造一个实验室临时目录并把目录 mtime 拨到指定年龄（毫秒前） */
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
