import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-glob-'));
process.env.DATA_DIR = tempDataDir;
process.env.CUSTOM_RULES_DIR = path.join(tempDataDir, 'rules-custom');

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
