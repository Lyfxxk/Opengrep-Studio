import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';
import { db, listRulePacks, type RulePack } from './db.js';
import { customPackDir, packRuleFiles } from './rulepacks.js';
import { isSampleKind } from './pack-format.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const rulesDir = path.join(srcDir, '..', 'rules');

export function isSafeSampleDirName(ruleId: string): boolean {
  const name = ruleId.replace(/\\/g, '/');
  return Boolean(name) && !name.includes('/') && name !== '.' && name !== '..';
}

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
  matchedRuleId?: string;
  found: boolean;
  pack?: { id: string; name: string; builtin: boolean };
  zhMessage?: string;
  severity?: string;
  securitySeverity?: number;
  cwe: KnowledgeCwe[];
  owasp: string[];
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

function normalizeCweId(raw: string): string {
  const match = raw.match(/CWE-0*(\d+)/i);
  return match ? `CWE-${match[1]}` : raw.trim();
}

export type KnowledgeLang = 'zh' | 'zh-Hant';

interface KnowledgeResources {
  messages: Record<string, string>;
  cwe: Record<string, { name: string; fix: string }>;
}

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
