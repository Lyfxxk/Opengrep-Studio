import fs from 'node:fs';
import path from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { engineInstallHint, runEngine } from './engine.js';
import { relativizeToRoot, stripRuleIdPrefix } from './engine-output.js';
import { parseRuleYaml } from './rule-yaml.js';
import { readSampleText, scanPackSamples } from './pack-format.js';
import { collectRuleFiles } from './rulepacks.js';
import { extractTaintFlow, relativizeTaintFlow, type TaintStep } from './taint.js';

/** 规则语言 → 样本文件扩展名（generic 用 .txt 匹配任意文本） */
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

interface RuleLabMatch {
  ruleId: string;
  checkId: string;
  startLine: number;
  endLine: number;
  startCol: number;
  severity: string;
  message: string;
  matchedLines?: string;
  /** taint 规则命中的污点传播链（source → intermediate → sink） */
  taintFlow?: TaintStep[];
}

interface RuleLabSampleResult {
  provided: boolean;
  matches: RuleLabMatch[];
}

export interface RuleLabRunResult {
  verdict: 'pass' | 'fail' | 'error';
  ruleIds: string[];
  language: string;
  durationMs: number;
  positive: RuleLabSampleResult;
  negative: RuleLabSampleResult;
  failReasons: string[];
  /** 引擎运行前的失败（YAML 不合法、无样本、语言未知） */
  error?: string;
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
  partial: Partial<RuleLabRunResult>,
  message: string,
  startedAt: number,
): RuleLabRunResult {
  return {
    verdict: 'error',
    ruleIds: [],
    language: '',
    durationMs: Date.now() - startedAt,
    positive: { provided: false, matches: [] },
    negative: { provided: false, matches: [] },
    failReasons: [],
    error: message,
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

/**
 * 实验室临时目录的保留期。单次实验被 ruleLabTimeoutMs（默认 30 秒）封顶，
 * 10 分钟远超其上限，足以区分"上次崩溃的残留"与"别的进程正在使用的目录"。
 */
const RULE_LAB_STALE_MS = 10 * 60 * 1000;

/**
 * 服务启动时清理上次异常退出残留的实验室临时目录。
 * 只删超过保留期的 lab-* 目录、不做整树 rmSync：rulelab 树由多个进程共用
 * （pack-regression 等独立进程也在这里建 scratch 跑引擎），而本服务会因 tsx watch
 * 热重启等原因频繁启动——整树删除会把别的进程刚建好、引擎即将读取的
 * rule.yaml 连根端掉，引擎侧表现为「配置文件 rule.yaml 不存在」。
 */
export function cleanupRuleLabScratch(): void {
  const scratchRoot = path.join(config.dataDir, 'rulelab');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scratchRoot, { withFileTypes: true });
  } catch {
    return; // rulelab 根目录尚不存在：无可清理
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
      // 目录被并发进程抢先清理等竞态：跳过即可
    }
  }
}

interface PackCheckItem {
  ruleId: string;
  /** 规则文件相对包根目录的路径 */
  ruleFile: string;
  positiveCount: number;
  negativeCount: number;
  verdict: 'pass' | 'fail' | 'error' | 'unverified';
  detail?: string;
}

export interface PackCheckResult {
  /** verified = 至少一条规则带样本且全部通过；basic = 无样本或存在未通过的样本 */
  tier: 'verified' | 'basic';
  items: PackCheckItem[];
  durationMs: number;
}

/**
 * 规则包质量检查：复用实验室 runner，逐规则跑它自己的正反例样本。
 * 无样本的规则记为 unverified（basic 档）；这是导入校验之外的"能不能命中"级验证。
 */
/** 单次质量检查最多实测的规则条数（其余记 unverified，避免大包把检查拖到分钟级） */
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
    for (const id of parseRuleYaml(text).ruleIds) knownIds.add(id);
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
          ? run.failReasons.join('；')
          : run.verdict === 'error'
            ? run.error ?? run.engineErrors[0] ?? '引擎执行失败'
            : undefined;
      items.push({
        ruleId,
        ruleFile: relFile,
        positiveCount,
        negativeCount,
        verdict: run.verdict,
        detail,
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

/**
 * 规则实验室单次实验：结构校验 → 临时目录跑引擎 → 按正/反例期望出三态结论。
 * "写错了"是实验室的常态，所有失败都以 error/fail 结果返回而不是 HTTP 错误。
 */
export async function runRuleLab(
  yamlText: string,
  samples: { positive: string; negative: string },
  languageHint?: string,
): Promise<RuleLabRunResult> {
  const startedAt = Date.now();

  if (!fs.existsSync(config.opengrepBin)) {
    return errorResult({}, engineInstallHint(), startedAt);
  }

  let ruleIds: string[];
  try {
    ruleIds = parseRuleYaml(yamlText).ruleIds;
  } catch (error) {
    return errorResult(
      {},
      `规则 YAML 不合法：${error instanceof Error ? error.message : String(error)}`,
      startedAt,
    );
  }

  const positive = samples.positive.trim();
  const negative = samples.negative.trim();
  if (!positive && !negative) {
    return errorResult({ ruleIds }, '请至少填写一个测试样本（正例或反例）', startedAt);
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
      { ruleIds },
      language
        ? `暂不支持为语言 ${language} 提供测试样本`
        : '无法从规则推断语言，请在第一条规则的 languages 中填写',
      startedAt,
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
    failReasons: [],
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
      result.engineErrors.push(`引擎超过 ${Math.round(config.ruleLabTimeoutMs / 1000)} 秒被终止`);
    }

    let output: EngineOutput | undefined;
    try {
      output = JSON.parse(stdout) as EngineOutput;
    } catch {
      // 引擎崩溃时没有 JSON 输出，错误信息从 stderr 取
    }
    for (const item of output?.errors ?? []) {
      if (item.level !== 'warn' && item.message) result.engineErrors.push(item.message);
    }
    if (!output) {
      result.engineErrors.push(
        (stderr.trim().split('\n').filter(Boolean).pop() ?? '').slice(0, 500)
          || `引擎输出无法解析（exit=${code}）`,
      );
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
      result.failReasons.push('正例未命中：期望至少 1 处命中，实际 0 处');
    }
    if (result.negative.provided && byKind.negative.length > 0) {
      const lines = byKind.negative.map((m) => m.startLine).join('、');
      result.failReasons.push(`反例出现误报：${byKind.negative.length} 处（第 ${lines} 行）`);
    }

    result.verdict =
      result.engineErrors.length > 0 || !output
        ? 'error'
        : result.failReasons.length > 0
          ? 'fail'
          : 'pass';
    return result;
  } finally {
    result.durationMs = Date.now() - startedAt;
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // Windows 上引擎子进程刚退出、文件句柄短暂未释放（或杀软扫描占用）时会抛 EPERM/EBUSY：
      // 清理失败不该把一次已成功的运行变成 500，残留的 scratch 目录在 dataDir/rulelab 下可手动清
    }
  }
}
