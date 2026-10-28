// archive.ts 解压安全分支单测（node --test 运行，`npm test` 统一驱动）
// 畸形条目（../ 穿越 / 绝对路径 / 伪体积）用 adm-zip 的 addFile 构不出来——
// 它会把条目名正常化改写（实测 '../evil.txt' 落盘成 'evil.txt'），所以统一用
// craftZip 手工拼 ZIP 二进制来构造恶意包。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { extractArchive, extractZipSafely, isPathWithin, safeRelativePath } from '../src/archive.ts';
import { config } from '../src/config.ts';

/**
 * 手工拼一个 ZIP 字节流（本地文件头 + 中央目录 + EOCD）。
 * entries: { name, method = 0（stored）| 8（deflate）, data = 实际写入的字节,
 *            crc = 默认按 data 计算, declaredSize / declaredCompSize = 中央目录声明的解压/压缩体积 }
 * 声明值默认与实际一致；造"伪体积""炸弹"时故意声明成假值。
 */
function craftZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 0;
    const data = entry.data;
    const crc = entry.crc ?? zlib.crc32(data);
    const declaredSize = entry.declaredSize ?? data.length;
    const declaredCompSize = entry.declaredCompSize ?? data.length;
    const nameBuf = Buffer.from(entry.name, 'utf8');

    const loc = Buffer.alloc(30 + nameBuf.length + data.length);
    loc.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    loc.writeUInt16LE(20, 4); // 解压所需版本
    loc.writeUInt16LE(0, 6); // 通用标志（无 data descriptor，CRC/体积以头部声明为准）
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(declaredCompSize, 18);
    loc.writeUInt32LE(declaredSize, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(loc, 30);
    data.copy(loc, 30 + nameBuf.length);
    locals.push(loc);

    const cen = Buffer.alloc(46 + nameBuf.length);
    cen.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(declaredCompSize, 20);
    cen.writeUInt32LE(declaredSize, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42); // 本地头偏移
    nameBuf.copy(cen, 46);
    centrals.push(cen);
    offset += loc.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 造一个一次性父目录；dest 是解压目标，刻意不预创建（拒绝路径应连目录都不落） */
function makeTemp() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  return { parent, dest: path.join(parent, 'dest') };
}

/** 断言抛出的是 400 且 meta.code 匹配的 HttpError，可选校验消息 */
function assertRejected(fn, code, messageRe) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.meta?.code, code);
    if (messageRe) assert.match(error.message, messageRe);
    return true;
  });
}

test('safeRelativePath 归一化相对路径（剥掉 . 段和空段，反斜杠转斜杠）', () => {
  assert.equal(safeRelativePath('src/a.ts'), 'src/a.ts');
  assert.equal(safeRelativePath('a/./b//c.txt'), 'a/b/c.txt');
  assert.equal(safeRelativePath('a\\b\\c.txt'), 'a/b/c.txt');
});

test('safeRelativePath 拒绝 .. 上跳、绝对路径与盘符', () => {
  // Windows 盘符与反斜杠写法在任何平台都要拦（正则与平台无关）
  for (const raw of ['../evil.txt', 'a/../b.txt', '..\\..\\escape.txt', '/abs.txt', '\\\\server\\share', 'C:/x.txt', 'c:\\x.txt', 'z:relative.txt']) {
    assertRejected(() => safeRelativePath(raw), 'archive.unsafePath', /不安全的路径条目/);
  }
});

test('safeRelativePath 平台非法字符：Windows 保留字符按平台拒绝，控制字符两侧都拒绝', () => {
  if (process.platform === 'win32') {
    // 不测 'a:b'：冒号紧跟首字母会先命中盘符分支（archive.unsafePath）
    for (const ch of ['<', '>', '"', '|', '?', '*']) {
      assertRejected(() => safeRelativePath(`bad${ch}name`), 'archive.illegalChars', /不允许的文件名字符/);
    }
  } else {
    // POSIX 上 Windows 保留字符是合法文件名，应原样放行
    assert.equal(safeRelativePath('bad<name|?"*>'), 'bad<name|?"*>');
  }
  assertRejected(() => safeRelativePath('bad\u0001name'), 'archive.illegalChars');
});

test('isPathWithin 遏制不变量：root 本身不算在内，兄弟与前缀相似目录都算逃逸', () => {
  const { parent, dest } = makeTemp();
  try {
    assert.equal(isPathWithin(dest, path.join(dest, 'a.ts')), true);
    assert.equal(isPathWithin(dest, path.join(dest, 'sub', 'a.ts')), true);
    // root 本身不在遏制范围内（target 等于 root 视为不合法）
    assert.equal(isPathWithin(dest, dest), false);
    // 兄弟目录与前缀相似目录（dest-evil 以 dest 为字符串前缀但不是子目录）
    assert.equal(isPathWithin(dest, path.join(parent, 'other')), false);
    assert.equal(isPathWithin(dest, `${dest}-evil`), false);
    // 带 .. 的 target 解析后逃逸
    assert.equal(isPathWithin(dest, path.join(dest, '..', 'x.txt')), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('extractZipSafely 拒绝 zip-slip 条目，目标目录内外都不落盘', () => {
  const { parent, dest } = makeTemp();
  try {
    // ../ 穿越、绝对路径、盘符各有独立拦截写法，逐个验证
    for (const name of ['../evil.txt', '..\\evil.txt', '/abs.txt', 'C:\\evil.txt']) {
      const zip = craftZip([{ name, data: Buffer.from('evil-content') }]);
      assertRejected(() => extractZipSafely(zip, dest), 'archive.unsafePath', /不安全的路径条目/);
    }
    // 拦截发生在解压循环之前：目标目录连创建都不该发生，父目录也不得出现逃逸文件
    assert.equal(fs.existsSync(dest), false);
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('extractZipSafely 拒绝归一化后为空的条目名（archive.zipUnsafePath）', () => {
  const { parent, dest } = makeTemp();
  try {
    // 条目名 '.' 经 safeRelativePath 归一化后变空串，走 zipUnsafePath 分支
    const zip = craftZip([{ name: '.', data: Buffer.from('x') }]);
    assertRejected(() => extractZipSafely(zip, dest), 'archive.zipUnsafePath');
    assert.equal(fs.existsSync(dest), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('extractZipSafely 拒绝伪体积条目：声明解压体积 0 却带压缩数据', () => {
  const { parent, dest } = makeTemp();
  try {
    // 声明 0 会让 adm-zip 解压时不设输出上限（zip 炸弹的经典伪装），必须在解压前拦下
    const compressed = zlib.deflateRawSync(Buffer.alloc(4096, 0x61));
    const zip = craftZip([
      { name: 'bomb.txt', method: 8, data: compressed, declaredSize: 0, declaredCompSize: compressed.length },
    ]);
    assertRejected(() => extractZipSafely(zip, dest), 'archive.zipFakeSize', /伪造体积/);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('extractZipSafely 声明体积超限：解压前拦截（临时调低上限触发）', () => {
  const { parent, dest } = makeTemp();
  // config 是模块级单例，测试里临时调小上限以小体积触发超限分支，finally 恢复
  const originalLimit = config.maxExtractedBytes;
  try {
    config.maxExtractedBytes = 10;
    const zip = craftZip([
      { name: 'a.txt', data: Buffer.alloc(8) },
      { name: 'b.txt', data: Buffer.alloc(8) },
    ]);
    assertRejected(() => extractZipSafely(zip, dest), 'archive.zipTooLarge');
    assert.equal(fs.existsSync(dest), false);
  } finally {
    config.maxExtractedBytes = originalLimit;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('extractZipSafely 拒绝实际膨胀超限的炸弹：声明 4 字节、真实膨胀 1MB', () => {
  const { parent, dest } = makeTemp();
  try {
    // 声明体积骗过前置累计后，解压时的实际字节数仍会失控：adm-zip 解压按声明体积
    // 设 maxOutputLength，膨胀超过声明直接抛 ERR_BUFFER_TOO_LARGE，写盘前即失败
    const compressed = zlib.deflateRawSync(Buffer.alloc(1024 * 1024, 0x61));
    const zip = craftZip([
      { name: 'bomb.bin', method: 8, data: compressed, declaredSize: 4, declaredCompSize: compressed.length },
    ]);
    assert.throws(() => extractZipSafely(zip, dest), (error) => error.code === 'ERR_BUFFER_TOO_LARGE');
    assert.equal(fs.existsSync(dest), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('extractArchive 把膨胀炸弹包装成 400 archive.extractFailed 并清掉半成品目录', async () => {
  const { parent, dest } = makeTemp();
  try {
    const compressed = zlib.deflateRawSync(Buffer.alloc(1024 * 1024, 0x61));
    const zip = craftZip([
      { name: 'bomb.bin', method: 8, data: compressed, declaredSize: 4, declaredCompSize: compressed.length },
    ]);
    await assert.rejects(extractArchive(zip, dest, 'bomb.zip'), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.meta?.code, 'archive.extractFailed');
      return true;
    });
    assert.equal(fs.existsSync(dest), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('extractZipSafely 正常 ZIP 解压成功且条目数正确（防过度拦截回归）', () => {
  const { parent, dest } = makeTemp();
  try {
    const zip = new AdmZip();
    zip.addFile('src/a.ts', Buffer.from('const a = 1;\n'));
    zip.addFile('src/lib/b.js', Buffer.from('module.exports = 2;\n'));
    const count = extractZipSafely(zip.toBuffer(), dest);
    assert.equal(count, 2);
    assert.equal(fs.readFileSync(path.join(dest, 'src', 'a.ts'), 'utf8'), 'const a = 1;\n');
    assert.equal(fs.readFileSync(path.join(dest, 'src', 'lib', 'b.js'), 'utf8'), 'module.exports = 2;\n');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
