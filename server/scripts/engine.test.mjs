import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineExecutableName, resolveEngineBin } from '../src/config.ts';
import { makeTempDir } from './script-utils.mjs';

function makeDirWith(fileName) {
  const dir = makeTempDir('engine-test-');
  fs.writeFileSync(path.join(dir, fileName), 'fake-binary', 'utf8');
  return dir;
}

test('engineExecutableName 按当前平台命名', () => {
  if (process.platform === 'win32') {
    assert.equal(engineExecutableName, 'opengrep.exe');
  } else {
    assert.equal(engineExecutableName, 'opengrep');
  }
});

test('OPENGREP_BIN 优先级最高，路径不存在也尊重用户（来源 env）', () => {
  const resolved = resolveEngineBin({ envBin: 'C:/does/not/exist/engine' });
  assert.equal(resolved.source, 'env');
  assert.equal(resolved.bin, 'C:/does/not/exist/engine');
});

test('安装位存在时使用安装位（来源 bundled-dir）', () => {
  const bundled = makeDirWith('opengrep');
  const resolved = resolveEngineBin({
    bundledPath: path.join(bundled, 'opengrep'),
    pathEnv: '',
  });
  assert.equal(resolved.source, 'bundled-dir');
  assert.equal(resolved.bin, path.join(bundled, 'opengrep'));
});

test('安装位缺失时回退 PATH 查找（来源 path）', () => {
  const onPathDir = makeDirWith(process.platform === 'win32' ? 'opengrep.exe' : 'opengrep');
  const resolved = resolveEngineBin({
    bundledPath: path.join(makeDirWith('placeholder-unused'), 'not-exist'),
    pathEnv: `/nonexistent-a${path.delimiter}${onPathDir}${path.delimiter}/nonexistent-b`,
  });
  assert.equal(resolved.source, 'path');
  assert.equal(path.dirname(resolved.bin), onPathDir);
});

test('全部落空时返回安装位并标记 missing（bin 指向 setup:engine 安装位）', () => {
  const bundled = path.join(os.tmpdir(), `engine-missing-${Date.now()}`, 'opengrep');
  const resolved = resolveEngineBin({ bundledPath: bundled, pathEnv: '/nonexistent-only' });
  assert.equal(resolved.source, 'missing');
  assert.equal(resolved.bin, bundled);
});

test('注入平台时安装位默认文件名跟随该平台，而不是进程平台', () => {
  const resolved = resolveEngineBin({ platform: 'win32', pathEnv: '' });
  assert.match(resolved.bin, /opengrep\.exe$/);
});

test('PATH 中的目录必须是普通文件，目录同名不算命中', () => {
  const dirNamedEngine = makeTempDir('engine-dir-');
  fs.mkdirSync(path.join(dirNamedEngine, engineExecutableName));
  const resolved = resolveEngineBin({
    bundledPath: path.join(os.tmpdir(), `engine-missing-${Date.now()}-2`, 'opengrep'),
    pathEnv: dirNamedEngine,
  });
  assert.equal(resolved.source, 'missing');
});
