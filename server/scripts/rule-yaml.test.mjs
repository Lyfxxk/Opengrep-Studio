// parseRuleYaml 结构校验单测（node --test 运行，`npm test` 统一驱动）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuleYaml } from '../src/rule-yaml.ts';

const VALID = `rules:
  - id: js-dangerous-eval
    languages: [javascript]
    message: 使用 eval 动态执行代码
    severity: WARNING
    pattern: eval(...)
`;

test('合法规则：返回规则数与 id 列表', () => {
  const parsed = parseRuleYaml(VALID);
  assert.equal(parsed.ruleCount, 1);
  assert.deepEqual(parsed.ruleIds, ['js-dangerous-eval']);
  assert.equal(parsed.firstLanguage, 'javascript');
});

test('YAML 语法错误：抛出并带原因', () => {
  assert.throws(() => parseRuleYaml('rules: [ { broken'), /YAML 解析失败/);
});

test('顶层缺少非空 rules 列表：拒绝', () => {
  assert.throws(() => parseRuleYaml('foo: bar'), /非空的 rules 列表/);
  assert.throws(() => parseRuleYaml('rules: []'), /非空的 rules 列表/);
});

test('缺少 id / languages / pattern 表达式：逐条报原因', () => {
  assert.throws(
    () => parseRuleYaml('rules:\n  - languages: [javascript]\n    pattern: eval(...)\n'),
    /缺少 id/,
  );
  assert.throws(
    () => parseRuleYaml('rules:\n  - id: a\n    message: x\n    pattern: eval(...)\n'),
    /缺少 languages/,
  );
  assert.throws(
    () => parseRuleYaml('rules:\n  - id: a\n    languages: [javascript]\n    message: x\n'),
    /缺少 pattern 类表达式/,
  );
});

test('taint 模式无需 pattern 前缀键', () => {
  const parsed = parseRuleYaml(`rules:
  - id: taint-eval
    languages: [javascript]
    message: x
    severity: ERROR
    mode: taint
    pattern-sources:
      - pattern: req.query
    pattern-sinks:
      - pattern: eval(...)
`);
  assert.equal(parsed.ruleCount, 1);
  assert.deepEqual(parsed.ruleIds, ['taint-eval']);
});

test('重复规则 id：拒绝', () => {
  assert.throws(
    () =>
      parseRuleYaml(`rules:
  - id: dup-rule
    languages: [javascript]
    message: x
    pattern: eval(...)
  - id: dup-rule
    languages: [javascript]
    message: y
    pattern: eval(...)
`),
    /重复的规则 id/,
  );
});

test('firstLanguage 取第一条规则 languages[0]', () => {
  const parsed = parseRuleYaml(`rules:
  - id: a
    languages: [python]
    message: x
    pattern: eval(...)
  - id: b
    languages: [javascript]
    message: x
    pattern: eval(...)
`);
  assert.equal(parsed.firstLanguage, 'python');
});
