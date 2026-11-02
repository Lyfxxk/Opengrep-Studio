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

const throwsCode = (fn, code) =>
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });

test('合法规则：返回规则数与 id 列表', () => {
  const parsed = parseRuleYaml(VALID);
  assert.equal(parsed.ruleCount, 1);
  assert.deepEqual(parsed.ruleIds, ['js-dangerous-eval']);
  assert.equal(parsed.firstLanguage, 'javascript');
});

test('YAML 语法错误：抛出并带原因', () => {
  throwsCode(() => parseRuleYaml('rules: [ { broken'), 'ruleYaml.parseFailed');
});

test('顶层缺少非空 rules 列表：拒绝', () => {
  throwsCode(() => parseRuleYaml('foo: bar'), 'ruleYaml.rulesMissing');
  throwsCode(() => parseRuleYaml('rules: []'), 'ruleYaml.rulesMissing');
});

function throwCode(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return undefined;
}

test('缺少 id / languages / pattern 表达式：逐条报原因', () => {
  throwsCode(
    () => parseRuleYaml('rules:\n  - languages: [javascript]\n    pattern: eval(...)\n'),
    'ruleYaml.missingId',
  );
  throwsCode(
    () => parseRuleYaml('rules:\n  - id: a\n    message: x\n    pattern: eval(...)\n'),
    'ruleYaml.missingLanguages',
  );
  throwsCode(
    () => parseRuleYaml('rules:\n  - id: a\n    languages: [javascript]\n    message: x\n'),
    'ruleYaml.missingPattern',
  );
});

test('校验失败带可翻译错误码与参数', () => {
  assert.equal(
    throwCode(() => parseRuleYaml('rules:\n  - languages: [javascript]\n    pattern: eval(...)\n')),
    'ruleYaml.missingId',
  );
  assert.equal(
    throwCode(() => parseRuleYaml('rules:\n  - id: a\n    message: x\n    pattern: eval(...)\n')),
    'ruleYaml.missingLanguages',
  );
  assert.equal(
    throwCode(() => parseRuleYaml('rules:\n  - id: a\n    languages: [javascript]\n    message: x\n')),
    'ruleYaml.missingPattern',
  );
  assert.equal(throwCode(() => parseRuleYaml('rules: [ { broken')), 'ruleYaml.parseFailed');
  assert.equal(throwCode(() => parseRuleYaml('foo: bar')), 'ruleYaml.rulesMissing');
  try {
    parseRuleYaml('rules:\n  - id: a\n    message: x\n    pattern: eval(...)\n');
    assert.fail('应当抛出');
  } catch (error) {
    assert.equal(error.code, 'ruleYaml.missingLanguages');
    assert.equal(error.params?.index, 1);
    assert.equal(error.params?.id, 'a');
  }
});

test('非对象规则条目：按缺少 id 报业务错误而不是 TypeError', () => {
  throwsCode(() => parseRuleYaml('rules:\n  - null\n'), 'ruleYaml.missingId');
  throwsCode(() => parseRuleYaml('rules:\n  - 42\n'), 'ruleYaml.missingId');
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
  throwsCode(
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
    'ruleYaml.duplicateId',
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
