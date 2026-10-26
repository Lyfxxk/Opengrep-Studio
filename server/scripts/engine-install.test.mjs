// 引擎安装/升级共用逻辑单测（node --test 运行，`npm test` 统一驱动）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  findAsset,
  normalizeVersion,
  parseDigest,
  readInstalledManifest,
  resolveTarget,
  writeInstalledManifest,
} from './engine-install.mjs';

const CATALOG = {
  version: 'v1.31.0',
  baseUrl: 'https://github.com/opengrep/opengrep/releases/download',
  assets: {
    'win32-x64': { file: 'opengrep_windows_x86.exe', sha256: 'a'.repeat(64) },
    'linux-x64': { file: 'opengrep_manylinux_x86', sha256: 'b'.repeat(64) },
  },
};

test('normalizeVersion 去掉 v 前缀', () => {
  assert.equal(normalizeVersion('v1.32.0'), '1.32.0');
  assert.equal(normalizeVersion(' 1.32.0 '), '1.32.0');
  assert.equal(normalizeVersion(undefined), '');
});

test('compareVersions 按数值比较（1.9 < 1.10）', () => {
  assert.equal(compareVersions('v1.32.0', '1.31.0'), 1);
  assert.equal(compareVersions('1.31.0', 'v1.32.0'), -1);
  assert.equal(compareVersions('v1.31.0', '1.31.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('0.9', '0.9.0'), 0);
});

test('parseDigest 只认 sha256:<64 位 hex>', () => {
  assert.equal(parseDigest(`sha256:${'A'.repeat(64)}`), 'a'.repeat(64));
  assert.equal(parseDigest('sha512:abcd'), undefined);
  assert.equal(parseDigest(null), undefined);
  assert.equal(parseDigest(`sha256:${'a'.repeat(63)}`), undefined);
});

test('findAsset 按资产名匹配，缺失时返回 undefined', () => {
  const release = {
    assets: [
      { name: 'opengrep_windows_x86.exe', url: 'https://api.github.com/assets/1', size: 10, digest: `sha256:${'c'.repeat(64)}` },
      { name: 'opengrep_windows_x86.exe.sig', url: 'https://api.github.com/assets/2', size: 96 },
    ],
  };
  const asset = findAsset(release, 'opengrep_windows_x86.exe');
  assert.equal(asset.url, 'https://api.github.com/assets/1');
  assert.equal(asset.sha256, 'c'.repeat(64));
  assert.equal(findAsset(release, 'opengrep_linux_x86'), undefined);
  assert.equal(findAsset({}, 'opengrep_windows_x86.exe'), undefined);
});

test('resolveTarget 默认用 engines.json 的钉住版本', () => {
  const target = resolveTarget({ catalog: CATALOG, installed: undefined, platform: 'win32' });
  assert.deepEqual(target, {
    version: 'v1.31.0',
    assetFile: 'opengrep_windows_x86.exe',
    sha256: 'a'.repeat(64),
    source: 'engines.json',
  });
});

test('resolveTarget 在 installed.json 更新时优先本地记录（升级后不被降级）', () => {
  const target = resolveTarget({
    catalog: CATALOG,
    installed: { version: 'v1.32.0', assetFile: 'opengrep_windows_x86.exe', sha256: 'd'.repeat(64) },
    platform: 'win32',
  });
  assert.equal(target.version, 'v1.32.0');
  assert.equal(target.sha256, 'd'.repeat(64));
  assert.equal(target.source, 'installed.json');
});

test('resolveTarget 在 installed.json 更旧时回到 engines.json（仓库追平后能前进）', () => {
  const target = resolveTarget({
    catalog: { ...CATALOG, version: 'v1.33.0' },
    installed: { version: 'v1.32.0', sha256: 'd'.repeat(64) },
    platform: 'win32',
  });
  assert.equal(target.version, 'v1.33.0');
  assert.equal(target.source, 'engines.json');
});

test('resolveTarget 平台无资产时抛出可读错误', () => {
  assert.throws(
    () => resolveTarget({ catalog: CATALOG, installed: undefined, platform: 'aix' }),
    /暂无 aix-.* 平台的自动下载支持/,
  );
});

test('installed.json 读写往返，损坏或字段缺失时视为不存在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-manifest-'));
  assert.equal(readInstalledManifest(dir), undefined, '文件缺失时返回 undefined');

  writeInstalledManifest(dir, {
    version: 'v1.32.0',
    assetFile: 'opengrep_windows_x86.exe',
    sha256: 'e'.repeat(64),
    channel: 'api.github.com 资产通道',
  });
  const read = readInstalledManifest(dir);
  assert.equal(read.version, 'v1.32.0');
  assert.equal(read.sha256, 'e'.repeat(64));
  assert.equal(read.channel, 'api.github.com 资产通道');
  assert.ok(read.installedAt, '自动补 installedAt');

  fs.writeFileSync(path.join(dir, 'installed.json'), '{"version":"v1.32.0"}', 'utf8');
  assert.equal(readInstalledManifest(dir), undefined, '缺 sha256 时视为无效');

  fs.writeFileSync(path.join(dir, 'installed.json'), 'not-json', 'utf8');
  assert.equal(readInstalledManifest(dir), undefined, '坏 JSON 视为无效');

  fs.rmSync(dir, { recursive: true, force: true });
});
