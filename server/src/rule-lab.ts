import fs from 'node:fs';
import path from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { engineInstallHint, engineInstallHintInfo, runEngine } from './engine.js';
import { relativizeToRoot, stripRuleIdPrefix } from './fs-walk.js';
import { readSampleText, scanPackSamples } from './pack-format.js';
import { collectRuleFiles } from './rulepacks.js';
import { extractTaintFlow, relativizeTaintFlow, type TaintStep } from './taint.js';

export const LANG_EXT: Record<string, string> = {
  javascript: 'js',
  typescript: 'ts',
  jsx: 'jsx',
  tsx: 'tsx',
  python: 'py',
  python2: 'py',
  python3: 'py',
  java: 'java',
  go: 'go',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  php: 'php',
  ruby: 'rb',
  kotlin: 'kt',
  swift: 'swift',
  rust: 'rs',
  bash: 'sh',
  sh: 'sh',
  lua: 'lua',
  scala: 'scala',
  json: 'json',
  yaml: 'yaml',
  dockerfile: 'dockerfile',
  generic: 'txt',
};

export class RuleYamlError extends Error {
  constructor(
    public code: string,
    message: string,
    public params?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function invalid(
  index: number,
  reason: string,
  code: string,
  params: Record<string, unknown> = {},
): never {
  throw new RuleYamlError(code, `规则条目不合法（第 ${index + 1} 条：${reason}）`, {
    index: index + 1,
    ...params,
  });
}

export function parseRuleYaml(text: string): {
  ruleCount: number;
  ruleIds: string[];
  firstLanguage: string;
} {
  let doc: unknown;
  try {
    doc = yamlLoad(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RuleYamlError('ruleYaml.parseFailed', `YAML 解析失败：${reason}`, { reason });
  }
  const rules = (doc as { rules?: unknown[] } | null)?.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new RuleYamlError('ruleYaml.rulesMissing', 'YAML 顶层需要非空的 rules 列表');
  }
  const ruleIds: string[] = [];
  let firstLanguage = '';
  rules.forEach((rule, index) => {
    const item = (
      typeof rule === 'object' && rule !== null ? rule : {}
    ) as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) {
      invalid(index, '缺少 id', 'ruleYaml.missingId');
    }
    if (!Array.isArray(item.languages) || item.languages.length === 0) {
      invalid(index, `规则 ${id} 缺少 languages`, 'ruleYaml.missingLanguages', { id });
    }
    if (!firstLanguage && typeof (item.languages as unknown[])[0] === 'string') {
      firstLanguage = String((item.languages as unknown[])[0]);
    }
    const hasPattern =
      item.mode === 'taint' ||
      Object.keys(item).some((key) => key.startsWith('pattern'));
    if (!hasPattern) {
      invalid(index, `规则 ${id} 缺少 pattern 类表达式或 taint 模式声明`, 'ruleYaml.missingPattern', {
        id,
      });
    }
    ruleIds.push(id);
  });
  const duplicate = ruleIds.find((id, index) => ruleIds.indexOf(id) !== index);
  if (duplicate) {
    throw new RuleYamlError('ruleYaml.duplicateId', `存在重复的规则 id：${duplicate}`, {
      id: duplicate,
    });
  }
  return { ruleCount: ruleIds.length, ruleIds, firstLanguage };
}

interface RuleLabMatch {
  ruleId: string;
  checkId: string;
  startLine: number;
  endLine: number;
  startCol: number;
  severity: string;
  message: string;
  matchedLines?: string;
  taintFlow?: TaintStep[];
}

interface RuleLabSampleResult {
  provided: boolean;
  matches: RuleLabMatch[];
}

export interface LabFailure {
  code: string;
  params?: Record<string, unknown>;
  message: string;
}

export interface RuleLabRunResult {
  verdict: 'pass' | 'fail' | 'error';
  ruleIds: string[];
  language: string;
  durationMs: number;
  positive: RuleLabSampleResult;
  negative: RuleLabSampleResult;
  failures: LabFailure[];
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, unknown>;
  engineErrors: string[];
}

interface EngineFinding {
  check_id: string;
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  extra: {
    message: string;
    severity: string;
    lines?: string;
    dataflow_trace?: unknown;
  };
}

interface EngineOutput {
  results?: EngineFinding[];
  errors?: Array<{ level?: string; message?: string }>;
}

function errorResult(
  failure: { code: string; params?: Record<string, unknown>; message: string },
  startedAt: number,
  partial: Partial<RuleLabRunResult> = {},
): RuleLabRunResult {
  return {
    verdict: 'error',
    ruleIds: [],
    language: '',
    durationMs: Date.now() - startedAt,
    positive: { provided: false, matches: [] },
    negative: { provided: false, matches: [] },
    failures: [],
    error: failure.message,
    errorCode: failure.code,
    ...(failure.params ? { errorParams: failure.params } : {}),
    engineErrors: [],
    ...partial,
  };
}


function sampleKindOf(findingPath: string): 'positive' | 'negative' | undefined {
  const base = path.basename(findingPath).toLowerCase();
  if (base.startsWith('positive.')) return 'positive';
  if (base.startsWith('negative.')) return 'negative';
  return undefined;
}

const RULE_LAB_STALE_MS = 10 * 60 * 1000;

export function cleanupRuleLabScratch(): void {
  const scratchRoot = path.join(config.dataDir, 'rulelab');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scratchRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const staleBefore = Date.now() - RULE_LAB_STALE_MS;
  for (const entry of entries) {
    if (!entry.name.startsWith('lab-')) continue;
    const dir = path.join(scratchRoot, entry.name);
    try {
      if (fs.statSync(dir).mtimeMs < staleBefore) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}

interface PackCheckItem {
  ruleId: string;
  ruleFile: string;
  positiveCount: number;
  negativeCount: number;
  verdict: 'pass' | 'fail' | 'error' | 'unverified';
  detail?: string;
  failures?: LabFailure[];
  errorCode?: string;
  errorParams?: Record<string, unknown>;
}

export interface PackCheckResult {
  tier: 'verified' | 'basic';
  items: PackCheckItem[];
  durationMs: number;
}

const MAX_SAMPLED_RULES = 20;

export async function runPackCheck(packDir: string): Promise<PackCheckResult> {
  const startedAt = Date.now();
  const ruleFiles = collectRuleFiles(path.join(packDir, 'rules'));
  if (ruleFiles.length === 0) {
    throw new HttpError(400, '包内 rules/ 目录没有任何 YAML 规则文件', { code: 'srv.noRulesInZip' });
  }

  const items: PackCheckItem[] = [];
  const knownIds = new Set<string>();
  const rulesByFile: Array<{ file: string; rules: Array<Record<string, unknown>> }> = [];
  for (const file of ruleFiles) {
    const text = fs.readFileSync(file, 'utf8');
    try {
      for (const id of parseRuleYaml(text).ruleIds) knownIds.add(id);
    } catch (error) {
      const name = path.relative(packDir, file).replace(/\\/g, '/');
      if (error instanceof RuleYamlError) {
        throw new HttpError(400, `规则文件 ${name} 不合法：${error.message}`, {
          code: 'srv.ruleFileInvalidDetail',
          params: { name, reasonCode: error.code, reasonParams: error.params },
        });
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new HttpError(400, `规则文件 ${name} 不合法：${reason}`, {
        code: 'srv.ruleFileInvalidDetail',
        params: { name, reason },
      });
    }
    const doc = yamlLoad(text) as { rules?: Array<Record<string, unknown>> } | null;
    rulesByFile.push({ file, rules: Array.isArray(doc?.rules) ? doc!.rules! : [] });
  }
  const { byRule } = scanPackSamples(packDir, knownIds);

  let sampled = 0;
  let sawSample = false;
  for (const { file, rules } of rulesByFile) {
    const relFile = path.relative(packDir, file).replace(/\\/g, '/');
    for (const rule of rules) {
      const ruleId = String(rule.id ?? '');
      const set = byRule.get(ruleId);
      const positiveCount = set?.positives.length ?? 0;
      const negativeCount = set?.negatives.length ?? 0;
      if (!set || (positiveCount === 0 && negativeCount === 0)) {
        items.push({ ruleId, ruleFile: relFile, positiveCount, negativeCount, verdict: 'unverified' });
        continue;
      }
      if (sampled >= MAX_SAMPLED_RULES) {
        items.push({
          ruleId,
          ruleFile: relFile,
          positiveCount,
          negativeCount,
          verdict: 'unverified',
          detail: `超出单次检查上限（${MAX_SAMPLED_RULES} 条），未验证`,
          errorCode: 'lab.sampleCapUnverified',
          errorParams: { limit: MAX_SAMPLED_RULES },
        });
        continue;
      }
      sampled += 1;
      const singleRuleYaml = yamlDump({ rules: [rule] });
      const run = await runRuleLab(
        singleRuleYaml,
        {
          positive: set.positives.map(readSampleText).join('\n\n'),
          negative: set.negatives.map(readSampleText).join('\n\n'),
        },
        typeof rule.languages === 'object' && rule.languages !== null
          ? String((rule.languages as unknown[])[0] ?? '')
          : undefined,
      );
      sawSample = true;
      const detail =
        run.verdict === 'fail'
          ? run.failures.map((item) => item.message).join('；')
          : run.verdict === 'error'
            ? run.error ?? run.engineErrors[0] ?? '引擎执行失败'
            : undefined;
      const errorCode =
        run.verdict !== 'error'
          ? undefined
          : run.errorCode ?? (run.engineErrors.length > 0 ? undefined : 'lab.engineFailed');
      items.push({
        ruleId,
        ruleFile: relFile,
        positiveCount,
        negativeCount,
        verdict: run.verdict,
        ...(detail ? { detail } : {}),
        ...(run.verdict === 'fail' && run.failures.length > 0 ? { failures: run.failures } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(run.verdict === 'error' && run.errorParams ? { errorParams: run.errorParams } : {}),
      });
    }
  }

  const hasBad = items.some((item) => item.verdict === 'fail' || item.verdict === 'error');
  return {
    tier: sawSample && !hasBad ? 'verified' : 'basic',
    items,
    durationMs: Date.now() - startedAt,
  };
}

export async function runRuleLab(
  yamlText: string,
  samples: { positive: string; negative: string },
  languageHint?: string,
): Promise<RuleLabRunResult> {
  const startedAt = Date.now();

  if (!fs.existsSync(config.opengrepBin)) {
    const hint = engineInstallHintInfo();
    return errorResult({ code: hint.code, params: hint.params, message: engineInstallHint() }, startedAt);
  }

  let ruleIds: string[];
  try {
    ruleIds = parseRuleYaml(yamlText).ruleIds;
  } catch (error) {
    const message = `规则 YAML 不合法：${error instanceof Error ? error.message : String(error)}`;
    if (error instanceof RuleYamlError) {
      return errorResult(
        {
          code: 'lab.ruleYamlInvalid',
          params: { reasonCode: error.code, reasonParams: error.params },
          message,
        },
        startedAt,
      );
    }
    return errorResult(
      {
        code: 'srv.ruleYamlInvalid',
        params: { reason: error instanceof Error ? error.message : String(error) },
        message,
      },
      startedAt,
    );
  }

  const positive = samples.positive.trim();
  const negative = samples.negative.trim();
  if (!positive && !negative) {
    return errorResult(
      { code: 'lab.samplesRequired', message: '请至少填写一个测试样本（正例或反例）' },
      startedAt,
      { ruleIds },
    );
  }

  let language = (languageHint ?? '').trim();
  if (!language) {
    try {
      const doc = yamlLoad(yamlText) as { rules?: Array<{ languages?: unknown }> } | null;
      const first = doc?.rules?.[0]?.languages;
      if (Array.isArray(first) && typeof first[0] === 'string') language = first[0];
    } catch {
    }
  }
  const ext = LANG_EXT[language.toLowerCase()];
  if (!ext) {
    return errorResult(
      {
        code: language ? 'srv.sampleLangUnsupported' : 'srv.ruleLanguageMissing',
        ...(language ? { params: { language } } : {}),
        message: language
          ? `暂不支持为语言 ${language} 提供测试样本`
          : '无法从规则推断语言，请在第一条规则的 languages 中填写',
      },
      startedAt,
      { ruleIds },
    );
  }

  const scratchDir = path.join(
    config.dataDir,
    'rulelab',
    `lab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const result: RuleLabRunResult = {
    verdict: 'error',
    ruleIds,
    language: language.toLowerCase(),
    durationMs: 0,
    positive: { provided: Boolean(positive), matches: [] },
    negative: { provided: Boolean(negative), matches: [] },
    failures: [],
    engineErrors: [],
  };
  try {
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, 'rule.yaml'), yamlText, 'utf8');
    if (positive) fs.writeFileSync(path.join(scratchDir, `positive.${ext}`), positive, 'utf8');
    if (negative) fs.writeFileSync(path.join(scratchDir, `negative.${ext}`), negative, 'utf8');

    const { code, stdout, stderr, timedOut } = await runEngine(
      [
        'scan',
        '--config', path.join(scratchDir, 'rule.yaml'),
        '--json',
        '--dataflow-traces',
        '--no-git-ignore',
        '--timeout', '10',
        '-j', '1',
        scratchDir,
      ],
      scratchDir,
      { timeoutMs: config.ruleLabTimeoutMs, logLabel: 'rule-lab' },
    );

    if (timedOut) {
      result.errorCode = 'lab.engineTimeout';
      result.errorParams = { seconds: Math.round(config.ruleLabTimeoutMs / 1000) };
    }

    let output: EngineOutput | undefined;
    try {
      output = JSON.parse(stdout) as EngineOutput;
    } catch {
    }
    for (const item of output?.errors ?? []) {
      if (item.level !== 'warn' && item.message) result.engineErrors.push(item.message);
    }
    if (!output) {
      const detail = (stderr.trim().split('\n').filter(Boolean).pop() ?? '').slice(0, 500);
      if (detail) result.engineErrors.push(detail);
      if (!result.errorCode) {
        result.errorCode = 'lab.outputUnparseable';
        result.errorParams = { exitCode: code };
      }
    }

    const byKind: Record<'positive' | 'negative', RuleLabMatch[]> = {
      positive: [],
      negative: [],
    };
    for (const finding of output?.results ?? []) {
      const kind = sampleKindOf(finding.path);
      if (!kind) continue;
      const taintFlow = relativizeTaintFlow(
        extractTaintFlow(finding.extra.dataflow_trace),
        (p) => relativizeToRoot(p, scratchDir),
      );
      byKind[kind].push({
        ruleId: stripRuleIdPrefix(finding.check_id, ruleIds),
        checkId: finding.check_id,
        startLine: finding.start.line,
        endLine: finding.end.line,
        startCol: finding.start.col,
        severity: finding.extra.severity,
        message: finding.extra.message,
        matchedLines: finding.extra.lines,
        ...(taintFlow ? { taintFlow } : {}),
      });
    }
    result.positive.matches = byKind.positive;
    result.negative.matches = byKind.negative;

    if (result.positive.provided && byKind.positive.length === 0) {
      result.failures.push({
        code: 'lab.positiveNoMatch',
        message: '正例未命中：期望至少 1 处命中，实际 0 处',
      });
    }
    if (result.negative.provided && byKind.negative.length > 0) {
      const lines = byKind.negative.map((m) => m.startLine).join('、');
      result.failures.push({
        code: 'lab.negativeFalsePositive',
        params: { count: byKind.negative.length, lines },
        message: `反例出现误报：${byKind.negative.length} 处（第 ${lines} 行）`,
      });
    }

    result.verdict =
      timedOut || result.engineErrors.length > 0 || !output
        ? 'error'
        : result.failures.length > 0
          ? 'fail'
          : 'pass';
    return result;
  } finally {
    result.durationMs = Date.now() - startedAt;
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
    }
  }
}
