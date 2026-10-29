import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';
import { db, listRulePacks, type RulePack } from './db.js';
import { customPackDir, packRuleFiles } from './rulepacks.js';
import { isSampleKind } from './pack-format.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const rulesDir = path.join(srcDir, '..', 'rules');

/**
 * 规则 ID 来自 YAML（不受信输入）：必须是单级安全目录名才可拼进 samples/<id>/ 路径，
 * 否则 id 含 ../ 或绝对路径时 path.join 会逃出 samples/（读侧与写侧共用此口径）
 */
export function isSafeSampleDirName(ruleId: string): boolean {
  const name = ruleId.replace(/\\/g, '/');
  return Boolean(name) && !name.includes('/') && name !== '.' && name !== '..';
}

/**
 * 规则知识库：按规则 ID 聚合
 *   规则包 YAML 元数据（severity/CWE/OWASP/上游溯源） + messages-zh[-Hant] 说明
 *   + CWE 解释与通用修复建议（server/rules/cwe-zh[-Hant].json） + 命中统计
 *   + 可移植规则包自带的正反例样本（如有）
 */

interface KnowledgeCwe {
  id: string;
  name?: string;
  fix?: string;
}

interface KnowledgeSample {
  name: string;
  content: string;
}

export interface RuleKnowledge {
  ruleId: string;
  /** 规则包中的完整规则 ID（issues 存的是剥离语言前缀的短 ID） */
  matchedRuleId?: string;
  found: boolean;
  pack?: { id: string; name: string; builtin: boolean };
  zhMessage?: string;
  severity?: string;
  securitySeverity?: number;
  cwe: KnowledgeCwe[];
  owasp: string[];
  /** CWE 级通用修复建议（来自 cwe-zh.json；逐规则建议待社区补全） */
  fixSuggestion?: string;
  upstreamUrl?: string;
  samples?: { positives: KnowledgeSample[]; negatives: KnowledgeSample[] };
  stats: { total: number; projects: number; lastSeen?: string };
}

interface PackRuleDoc {
  id?: unknown;
  severity?: unknown;
  metadata?: Record<string, unknown> | null;
}

const SAMPLE_MAX_BYTES = 8 * 1024;
const SAMPLE_MAX_FILES = 2;

// 规则包 YAML 解析缓存（按文件路径 + mtime 失效），避免每次知识查询重读全部规则包
const yamlCache = new Map<string, { mtimeMs: number; doc: PackRuleDoc[] | null }>();

function parsePackRuleFile(file: string): PackRuleDoc[] | null {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const cached = yamlCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.doc;
  let doc: PackRuleDoc[] | null = null;
  try {
    const parsed = yamlLoad(fs.readFileSync(file, 'utf8')) as { rules?: PackRuleDoc[] } | null;
    doc = Array.isArray(parsed?.rules) ? parsed!.rules! : null;
  } catch {
    doc = null;
  }
  yamlCache.set(file, { mtimeMs, doc });
  return doc;
}

/** messages-zh.json 的键是完整规则 ID（如 python.avoid-pickle），这里做精确/后缀匹配 */
function matchZhMessage(map: Record<string, string>, ruleId: string, matchedRuleId?: string): string | undefined {
  const candidates = [matchedRuleId, ruleId].filter((v): v is string => Boolean(v));
  for (const id of candidates) {
    if (map[id]) return map[id];
    const suffix = `.${id}`;
    const hit = Object.keys(map).find((key) => key === id || key.endsWith(suffix));
    if (hit) return map[hit];
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

/** CWE 编号规范化：去前导零（CWE-078 → CWE-78） */
function normalizeCweId(raw: string): string {
  const match = raw.match(/CWE-0*(\d+)/i);
  return match ? `CWE-${match[1]}` : raw.trim();
}

export type KnowledgeLang = 'zh' | 'zh-Hant';

interface KnowledgeResources {
  messages: Record<string, string>;
  cwe: Record<string, { name: string; fix: string }>;
}

// 按语言缓存：简繁各一份；文件缺失时回空表，前端自然回落规则原文
const resourcesCache = new Map<KnowledgeLang, KnowledgeResources>();

function loadResources(lang: KnowledgeLang): KnowledgeResources {
  const cached = resourcesCache.get(lang);
  if (cached) return cached;
  const suffix = lang === 'zh-Hant' ? '-Hant' : '';
  const read = <T,>(fileName: string, fallback: T): T => {
    try {
      return JSON.parse(fs.readFileSync(path.join(rulesDir, fileName), 'utf8')) as T;
    } catch {
      return fallback;
    }
  };
  const resources: KnowledgeResources = {
    messages: read(`messages-zh${suffix}.json`, {}),
    cwe: read(`cwe-zh${suffix}.json`, {}),
  };
  resourcesCache.set(lang, resources);
  return resources;
}

/** 报告/离线 HTML 用的整表读取：键为完整规则 ID，值为当前语言说明；英文无表（走引擎原文） */
export function listRuleMessages(lang: KnowledgeLang): Record<string, string> {
  return loadResources(lang).messages;
}

function readSample(dir: string, kind: 'positive' | 'negative'): KnowledgeSample[] {
  const out: KnowledgeSample[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !isSampleKind(entry.name, kind)) continue;
    if (out.length >= SAMPLE_MAX_FILES) break;
    try {
      const stat = fs.statSync(path.join(dir, entry.name));
      const fd = fs.openSync(path.join(dir, entry.name), 'r');
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, SAMPLE_MAX_BYTES));
        fs.readSync(fd, buffer, 0, buffer.length, 0);
        out.push({ name: entry.name, content: buffer.toString('utf8') });
      } finally {
        fs.closeSync(fd);
      }
    } catch {
    }
  }
  return out;
}

function findRule(ruleId: string): { rule: PackRuleDoc; matchedRuleId: string; pack: RulePack } | undefined {
  for (const pack of listRulePacks()) {
    for (const file of packRuleFiles(pack)) {
      const rules = parsePackRuleFile(file);
      if (!rules) continue;
      for (const rule of rules) {
        const id = typeof rule.id === 'string' ? rule.id : '';
        if (!id) continue;
        if (id === ruleId || id.endsWith(`.${ruleId}`)) {
          return { rule, matchedRuleId: id, pack };
        }
      }
    }
  }
  return undefined;
}

function hitStats(ruleId: string): RuleKnowledge['stats'] {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT s.project_id) AS projects, MAX(s.scanned_at) AS lastSeen
         FROM issues i JOIN scans s ON s.id = i.scan_id WHERE i.rule_id = ?`,
      )
      .get(ruleId) as { total: number | bigint; projects: number | bigint; lastSeen: string | null };
    return {
      total: Number(row?.total ?? 0),
      projects: Number(row?.projects ?? 0),
      ...(row?.lastSeen ? { lastSeen: row.lastSeen } : {}),
    };
  } catch {
    return { total: 0, projects: 0 };
  }
}

/** 聚合一条规则的知识条目；规则不在任何包中时 found=false，仍返回当前语言的说明与命中统计 */
export function getRuleKnowledge(ruleId: string, lang: KnowledgeLang = 'zh'): RuleKnowledge {
  const found = findRule(ruleId);
  const { messages, cwe: cweMap } = loadResources(lang);
  const zhMessage = matchZhMessage(messages, ruleId, found?.matchedRuleId);

  const result: RuleKnowledge = {
    ruleId,
    ...(found ? { matchedRuleId: found.matchedRuleId, pack: { id: found.pack.id, name: found.pack.name, builtin: found.pack.builtin } } : {}),
    found: Boolean(found),
    ...(zhMessage ? { zhMessage } : {}),
    cwe: [],
    owasp: [],
    stats: hitStats(ruleId),
  };

  if (!found) return result;

  const metadata = (found.rule.metadata ?? {}) as Record<string, unknown>;
  if (typeof found.rule.severity === 'string') {
    result.severity = found.rule.severity;
  }
  const securitySeverity = Number(metadata['security-severity']);
  if (Number.isFinite(securitySeverity) && securitySeverity > 0) {
    result.securitySeverity = securitySeverity;
  }

  // cwe-zh.json 的键是裸编号（"310"）；兼容 "CWE-310" 全称键
  const cweZhById = (id: string) => cweMap[id] ?? cweMap[id.replace(/^CWE-/i, '')];
  const cweIds = [...new Set(asStringArray(metadata.cwe).map(normalizeCweId))].slice(0, 8);
  result.cwe = cweIds.map((id) => ({
    id,
    ...(cweZhById(id)?.name ? { name: cweZhById(id).name } : {}),
    ...(cweZhById(id)?.fix ? { fix: cweZhById(id).fix } : {}),
  }));
  const firstFix = cweIds.map((id) => cweZhById(id)?.fix).find(Boolean);
  if (firstFix) result.fixSuggestion = firstFix;

  result.owasp = asStringArray(metadata.owasp).slice(0, 6);

  const upstream = metadata['opengrep-studio'] as Record<string, unknown> | null | undefined;
  const upstreamPath = typeof upstream?.['upstream-path'] === 'string' ? upstream['upstream-path'] : undefined;
  if (upstreamPath) {
    result.upstreamUrl = `https://github.com/opengrep/opengrep-rules/tree/main/${upstreamPath.replace(/^\/+/, '')}`;
  }

  // 可移植目录包可能带正反例样本（samples/<规则ID>/），有则展示
  // 规则 ID 来自 YAML（不受信输入），必须确保是安全的单级目录名才可拼入路径，
  // 否则 id 含 ../ 或绝对路径时 path.join 会逃出 samples/ 读到外部文件
  const sampleRoot = path.join(customPackDir(found.pack.id), 'samples');
  const sampleDirName = (found.matchedRuleId ?? ruleId).replace(/\\/g, '/');
  if (isSafeSampleDirName(sampleDirName)) {
    const sampleDir = path.join(sampleRoot, sampleDirName);
    const positives = readSample(sampleDir, 'positive');
    const negatives = readSample(sampleDir, 'negative');
    if (positives.length > 0 || negatives.length > 0) {
      result.samples = { positives, negatives };
    }
  }
  return result;
}
