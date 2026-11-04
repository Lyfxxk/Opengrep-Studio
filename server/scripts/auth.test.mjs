import { trackTempDir, useTempDataDir } from './script-utils.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = useTempDataDir('og-auth-');

const { closeDatabase, deleteUser, getUserByUsername, insertUser, updateUserPassword, updateUserRole } = await import('../src/db.ts');
const {
  clearSessionCookie,
  ensureInitialAdmin,
  getSessionUser,
  hashPassword,
  issueSessionCookie,
  verifyPassword,
} = await import('../src/auth.ts');
trackTempDir(tempDataDir, closeDatabase);

function fakeRequest(cookie) {
  return { headers: cookie ? { cookie } : {} };
}

function cookieCapture() {
  let value;
  return {
    res: { appendHeader(_name, header) { value = header; } },
    header: () => value,
  };
}

test('scrypt 哈希可验证且随机 salt 每次不同', () => {
  const first = hashPassword('secret-pass');
  const second = hashPassword('secret-pass');
  assert.notEqual(first, second);
  assert.match(first, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(verifyPassword('secret-pass', first), true);
  assert.equal(verifyPassword('wrong-pass', first), false);
  assert.equal(verifyPassword('secret-pass', 'scrypt:zz:zz'), false);
  assert.equal(verifyPassword('secret-pass', 'plaintext'), false);
});

test('users 空表时播种初始 admin 且幂等', () => {
  ensureInitialAdmin();
  const admin = getUserByUsername('admin');
  assert.ok(admin);
  assert.equal(admin.role, 'admin');
  assert.equal(verifyPassword('123456', admin.passwordHash), true);
  ensureInitialAdmin();
  assert.equal(getUserByUsername('admin').id, admin.id);
});

let sessionCookieValue;

test('会话签发后可校验，篡改或伪造即失效', () => {
  insertUser({
    id: 'user-s1',
    username: 'session-user',
    passwordHash: hashPassword('pw-1'),
    role: 'viewer',
    createdAt: '2026-11-05T00:00:00.000Z',
  });
  const user = getUserByUsername('session-user');
  const { res, header } = cookieCapture();
  issueSessionCookie(res, user);
  sessionCookieValue = header();
  assert.match(sessionCookieValue, /^og_session=/);
  assert.match(sessionCookieValue, /HttpOnly/);
  assert.match(sessionCookieValue, /SameSite=Lax/);
  assert.match(sessionCookieValue, /Path=\//);
  assert.deepEqual(getSessionUser(fakeRequest(sessionCookieValue)), {
    uid: 'user-s1',
    username: 'session-user',
    role: 'viewer',
  });
  const token = sessionCookieValue.split(';')[0].slice('og_session='.length);
  assert.equal(getSessionUser(fakeRequest(`og_session=${token}x`)), undefined);
  const dot = token.lastIndexOf('.');
  const flipped = `og_session=${token.slice(0, dot + 1)}${token[dot + 1] === 'A' ? 'B' : 'A'}${token.slice(dot + 2)}`;
  assert.equal(getSessionUser(fakeRequest(flipped)), undefined);
  assert.equal(getSessionUser(fakeRequest('og_session=garbage.payload')), undefined);
  assert.equal(getSessionUser(fakeRequest(undefined)), undefined);
});

test('重置密码、变更角色或删除用户后旧会话立即失效', () => {
  updateUserPassword('user-s1', hashPassword('pw-2'));
  assert.equal(getSessionUser(fakeRequest(sessionCookieValue)), undefined);
  const renewed = cookieCapture();
  issueSessionCookie(renewed.res, getUserByUsername('session-user'));
  sessionCookieValue = renewed.header();
  assert.equal(getSessionUser(fakeRequest(sessionCookieValue)).username, 'session-user');

  updateUserRole('user-s1', 'auditor');
  assert.equal(getSessionUser(fakeRequest(sessionCookieValue)), undefined);
  const promoted = cookieCapture();
  issueSessionCookie(promoted.res, getUserByUsername('session-user'));
  assert.equal(getSessionUser(fakeRequest(promoted.header())).role, 'auditor');

  deleteUser('user-s1');
  assert.equal(getSessionUser(fakeRequest(promoted.header())), undefined);
});

test('登出清空会话 cookie', () => {
  const { res, header } = cookieCapture();
  clearSessionCookie(res);
  assert.match(header(), /^og_session=;/);
  assert.match(header(), /Max-Age=0/);
});
