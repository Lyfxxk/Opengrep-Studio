import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedHost } from '../src/host-guard.ts';

test('回环地址与 localhost 始终放行', () => {
  assert.equal(isAllowedHost('localhost', '192.168.1.5'), true);
  assert.equal(isAllowedHost('127.0.0.1', undefined), true);
  assert.equal(isAllowedHost('::1', '192.168.1.5'), true);
  assert.equal(isAllowedHost('[::1]', undefined), true);
});

test('Host 与实际连接的本机地址一致时放行（含 IPv4 映射与方括号形式）', () => {
  assert.equal(isAllowedHost('192.168.1.5', '192.168.1.5'), true);
  assert.equal(isAllowedHost('192.168.1.5', '::ffff:192.168.1.5'), true);
  assert.equal(isAllowedHost('[fe80::1]', 'fe80::1'), true);
  assert.equal(isAllowedHost('fe80::1', '[fe80::1]'), true);
});

test('任意外网 IP 或域名不再被当成“本机地址”放行', () => {
  assert.equal(isAllowedHost('8.8.8.8', '127.0.0.1'), false);
  assert.equal(isAllowedHost('8.8.8.8', undefined), false);
  assert.equal(isAllowedHost('evil.example', '127.0.0.1'), false);
  assert.equal(isAllowedHost('192.168.1.5', '127.0.0.1'), false);
  assert.equal(isAllowedHost('', '127.0.0.1'), false);
});
