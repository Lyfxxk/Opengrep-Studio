// 克隆失败信息脱敏回归（node --test 运行，`npm test` 统一驱动）
// 历史 bug：redactSecrets 用 URL 解码后的 username/password 去匹配 git 回显的原始 URL，
// 密码含 @ : / 等会被百分号编码的字符时永远匹配不上，凭据随错误信息/日志外泄。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/git-clone.ts';

test('百分号编码的凭据同样被脱敏', () => {
  const text = "fatal: unable to access 'https://user:p%40ss@github.com/a/b.git/': Failed to connect";
  const out = redactSecrets(text);
  assert.ok(!out.includes('p%40ss'), out);
  assert.ok(!out.includes('user:'), out);
  assert.ok(out.includes('https://***@github.com/a/b.git/'), out);
});

test('多层编码字符（斜杠/冒号）不残留', () => {
  const text = "fatal: unable to access 'http://robot:p%2Fss%3Aword@example.com/repo.git/'";
  const out = redactSecrets(text);
  assert.ok(!out.includes('p%2Fss'), out);
  assert.ok(!out.includes('robot'), out);
  assert.ok(out.includes('http://***@example.com/repo.git/'), out);
});

test('无凭据的 URL 原样保留', () => {
  const text = "fatal: unable to access 'https://github.com/a/b.git/': 404";
  assert.equal(redactSecrets(text), text);
});
