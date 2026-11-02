import { config } from './config.js';
import { HttpError } from './errors.js';
import type { IssueRow, Severity } from './db.js';

interface SarifRegion {
  startLine?: number;
  endLine?: number;
}

interface SarifPhysicalLocation {
  artifactLocation?: { uri?: string; uriBaseId?: string };
  region?: SarifRegion;
}

interface SarifMessage {
  text?: string;
  markdown?: string;
}

interface SarifRule {
  id?: string;
  shortDescription?: SarifMessage;
  fullDescription?: SarifMessage;
}

interface SarifResult {
  ruleId?: string;
  ruleIndex?: number;
  level?: string;
  message?: SarifMessage;
  locations?: Array<{ physicalLocation?: SarifPhysicalLocation }>;
  partialFingerprints?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

interface SarifRun {
  tool?: {
    driver?: { name?: string; rules?: SarifRule[] };
  };
  results?: SarifResult[];
}

interface SarifLog {
  version?: string;
  runs?: SarifRun[];
}

export interface SarifImportResult {
  toolName: string;
  issues: IssueRow[];
}

const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low']);

function severityFromLevel(level: string | undefined): Severity {
  switch (level) {
    case 'error': return 'high';
    case 'warning': return 'medium';
    default: return 'low';
  }
}

function severityOf(result: SarifResult): Severity {
  const tagged = result.properties?.severity;
  if (typeof tagged === 'string' && SEVERITIES.has(tagged)) {
    return tagged as Severity;
  }
  return severityFromLevel(result.level);
}

function normalizeUri(raw: string): string {
  let uri = raw.trim();
  if (/^file:\/\//i.test(uri)) {
    uri = uri.replace(/^file:\/\//i, '');
    try {
      uri = decodeURIComponent(uri);
    } catch {
    }
  }
  uri = uri.replace(/\\/g, '/').replace(/^\.\//, '');
  return uri.replace(/^\/(?=[A-Za-z]:\/)/, '');
}

function linesOf(region: SarifRegion | undefined): { startLine: number; endLine: number } {
  const start = Number(region?.startLine ?? 0);
  const startLine = Number.isInteger(start) && start >= 1 ? start : 1;
  const end = Number(region?.endLine ?? 0);
  const endLine = Number.isInteger(end) && end >= startLine ? end : startLine;
  return { startLine, endLine };
}

function fingerprintOf(result: SarifResult, ruleId: string, uri: string, startLine: number): string {
  const fps = result.partialFingerprints;
  if (fps && typeof fps === 'object' && !Array.isArray(fps)) {
    const preferred = fps['opengrepFingerprint/v1'] ?? Object.values(fps)[0];
    const value =
      typeof preferred === 'string'
        ? preferred
        : preferred && typeof preferred === 'object'
          ? String(Object.values(preferred as Record<string, unknown>)[0] ?? '')
          : '';
    if (value) return value;
  }
  return `${ruleId}:${uri}:${startLine}`;
}

function messageOf(result: SarifResult, rule: SarifRule | undefined): string {
  const text = result.message?.text?.trim() || result.message?.markdown?.trim();
  if (text) return text;
  const fromRule = rule?.shortDescription?.text?.trim() || rule?.fullDescription?.text?.trim();
  return fromRule || '';
}

export function parseSarifImport(text: string): SarifImportResult {
  let doc: SarifLog;
  try {
    doc = JSON.parse(text) as SarifLog;
  } catch (error) {
    throw new HttpError(
      400,
      `SARIF 文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      { code: 'sarif.invalidJson', params: { reason: error instanceof Error ? error.message : String(error) } },
    );
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new HttpError(400, 'SARIF 文件顶层必须是 JSON 对象', { code: 'sarif.notObject' });
  }
  if (typeof doc.version !== 'string' || !doc.version.startsWith('2.')) {
    throw new HttpError(400, `仅支持 SARIF 2.x（当前 version: ${doc.version ?? '缺失'}）`, {
      code: 'sarif.versionUnsupported',
      params: { version: String(doc.version ?? '缺失') },
    });
  }
  if (!Array.isArray(doc.runs)) {
    throw new HttpError(400, 'SARIF 文件缺少 runs 数组', { code: 'sarif.runsMissing' });
  }

  const issues: IssueRow[] = [];
  const seenFingerprints = new Set<string>();
  let toolName = '';
  let totalResults = 0;

  for (const run of doc.runs) {
    const driver = run?.tool?.driver;
    const rules = Array.isArray(driver?.rules) ? driver!.rules! : [];
    if (!toolName && typeof driver?.name === 'string' && driver.name.trim()) {
      toolName = driver.name.trim();
    }
    for (const result of run?.results ?? []) {
      totalResults += 1;
      if (totalResults > config.maxImportEntries) {
        throw new HttpError(400, `SARIF 结果数超过 ${config.maxImportEntries} 上限`, {
          code: 'sarif.tooManyResults',
          params: { limit: config.maxImportEntries },
        });
      }
      const rule =
        (typeof result.ruleIndex === 'number' ? rules[result.ruleIndex] : undefined) ?? undefined;
      const ruleId = (result.ruleId ?? rule?.id ?? '').trim();
      if (!ruleId) continue;

      const physical = result.locations?.[0]?.physicalLocation;
      const uri = normalizeUri(physical?.artifactLocation?.uri ?? '');
      const { startLine, endLine } = linesOf(physical?.region);
      const fingerprint = fingerprintOf(result, ruleId, uri, startLine);
      if (seenFingerprints.has(fingerprint)) continue;
      seenFingerprints.add(fingerprint);

      issues.push({
        id: '',
        scanId: '',
        fingerprint,
        ruleId,
        severity: severityOf(result),
        comparisonStatus: 'remaining',
        message: messageOf(result, rule),
        filePath: uri,
        startLine,
        endLine,
        matchedLines: undefined,
        rulepackId: undefined,
        rulepackName: undefined,
      });
    }
  }

  return { toolName, issues };
}
