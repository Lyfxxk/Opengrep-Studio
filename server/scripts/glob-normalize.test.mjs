// 扫描 include/exclude glob 归一化回归（node --test 运行，`npm test` 统一驱动）
// 引擎实测：中间 `src/**​/f` 不含直接子文件、末尾 `dir/**` 只含直接子文件，
// 原实现把 `**​/` 直接删掉会把 `src/**​/*.py` 收窄成 `src/*.py`；include 现展开成两条。
// DATA_DIR 必须在动态导入 scan-runner（会打开 db）之前指向临时目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-glob-'));
process.env.DATA_DIR = tempDataDir;

const { normalizeGlob, ScanError } = await import('../src/scan-runner.ts');
const { closeDatabase } = await import('../src/db.ts');
const { trackTempDir } = await import('./temp-dir.mjs');
trackTempDir(tempDataDir, closeDatabase);

test('include：中间 **/ 展开为零层与一层以上', () => {
  assert.deepEqual(normalizeGlob('src/**/*.py', 'include'), ['src/*.py', 'src/**/*.py']);
  assert.deepEqual(normalizeGlob('**/*.py', 'include'), ['*.py', '**/*.py']);
  assert.deepEqual(normalizeGlob('src/**/test/*.py', 'include'), [
    'src/test/*.py',
    'src/**/test/*.py',
  ]);
});

test('include：末尾 /** 覆盖整棵子树，而不是只剩目录名', () => {
  assert.deepEqual(normalizeGlob('vendor/**', 'include'), ['vendor/*', 'vendor/**/*']);
});

test('include：末尾 /** 与中间 **/ 组合同样补零层变体', () => {
  // 两个产物若都只留中间 **/，src/generated/ 的直接子文件两个都匹配不到
  assert.deepEqual(normalizeGlob('src/**/generated/**', 'include'), [
    'src/generated/*',
    'src/generated/**/*',
    'src/**/generated/*',
    'src/**/generated/**/*',
  ]);
});

test('include：普通 * 与单段 ** 写法保持可用', () => {
  assert.deepEqual(normalizeGlob('*.py', 'include'), ['*.py']);
  assert.deepEqual(normalizeGlob('src/**.py', 'include'), ['src/*.py']);
});

test('include：**/ 段数有上限，超限显式失败而不是指数展开', () => {
  // 每个中间 **/ 段让变体翻倍：上限 4 段时 2^4 = 16 个变体（写入侧 misc.ts 共用同一常量）
  assert.equal(normalizeGlob('a/**/b/**/c/**/d/**/e/*.py', 'include').length, 16);
  assert.throws(
    () => normalizeGlob('a/**/b/**/c/**/d/**/e/**/f/*.py', 'include'),
    (error) => error instanceof ScanError && error.code === 'scan.includeGlobstarsTooMany',
  );
});

test('exclude：保持保守近似（引擎不支持带通配符的路径模式）', () => {
  assert.deepEqual(normalizeGlob('**/skip.py', 'exclude'), ['skip.py']);
  assert.deepEqual(normalizeGlob('dist/**', 'exclude'), ['dist']);
  assert.deepEqual(normalizeGlob('src/**/skip.py', 'exclude'), ['src/skip.py']);
});
