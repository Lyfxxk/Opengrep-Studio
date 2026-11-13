import { config } from './config.js';
import type { IssueRow, ScanRecord, Severity } from './db.js';
import { HttpError } from './errors.js';

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';

const LEVEL_BY_SEVERITY: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
};

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        version?: string;
        semanticVersion?: string;
        rules: Array<{
          id: string;
          name?: string;
          default?: { level: 'error' | 'warning' | 'note' };
          properties?: Record<string, unknown>;
        }>;
      };
    };
    automationDetails?: { id: string };
    originalUriBaseIds?: Record<string, { description: { text: string } }>;
    results: Array<{
      ruleId: string;
      ruleIndex: number;
      level: 'error' | 'warning' | 'note';
      message: { text: string };
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string; uriBaseId?: string };
          region: { startLine: number; endLine: number };
        };
      }>;
      partialFingerprints?: Record<string, string>;
      properties?: Record<string, unknown>;
    }>;
  }>;
}

export function buildSarifReport(
  scan: ScanRecord,
  issues: IssueRow[],
  engineVersion?: string,
): SarifLog {
  const current = issues.filter((issue) => issue.comparisonStatus !== 'fixed');

  const ruleIds: string[] = [];
  const severityByRule = new Map<string, Severity>();
  for (const issue of current) {
    if (!severityByRule.has(issue.ruleId)) {
      ruleIds.push(issue.ruleId);
      severityByRule.set(issue.ruleId, issue.severity);
    }
  }
  const rules = ruleIds.map((ruleId) => ({
    id: ruleId,
    default: { level: LEVEL_BY_SEVERITY[severityByRule.get(ruleId) ?? 'low'] },
    properties: {
      'opengrep-studio/severity': severityByRule.get(ruleId) ?? 'low',
    },
  }));
  const ruleIndexById = new Map(ruleIds.map((ruleId, index) => [ruleId, index]));

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Opengrep Studio (opengrep)',
            informationUri: 'https://github.com/opengrep/opengrep',
            ...(engineVersion ? { version: engineVersion, semanticVersion: engineVersion } : {}),
            rules,
          },
        },
        automationDetails: { id: `opengrep-studio/${scan.id}` },
        originalUriBaseIds: {
          SRCROOT: { description: { text: 'Source snapshot root' } },
        },
        results: current.map((issue) => ({
          ruleId: issue.ruleId,
          ruleIndex: ruleIndexById.get(issue.ruleId) ?? 0,
          level: LEVEL_BY_SEVERITY[issue.severity],
          message: { text: issue.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: (issue.filePath || '.').replace(/\\/g, '/'),
                  uriBaseId: 'SRCROOT',
                },
                region: {
                  startLine: Math.max(1, issue.startLine),
                  endLine: Math.max(issue.startLine, issue.endLine),
                },
              },
            },
          ],
          partialFingerprints: {
            'opengrepFingerprint/v1': issue.fingerprint,
          },
          properties: {
            severity: issue.severity,
            comparisonStatus: issue.comparisonStatus,
            ...(issue.rulepackName ? { rulepack: issue.rulepackName } : {}),
          },
        })),
      },
    ],
  };
}

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

interface SarifDocument {
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

export function parseSarifImport(input: string): SarifImportResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let doc: SarifDocument;
  try {
    doc = JSON.parse(text) as SarifDocument;
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
    if (typeof run !== 'object' || run === null || Array.isArray(run)) {
      throw new HttpError(400, 'SARIF runs 数组的每一项必须是对象', { code: 'sarif.runInvalid' });
    }
    const driver = run?.tool?.driver;
    const rules = Array.isArray(driver?.rules) ? driver!.rules! : [];
    if (!toolName && typeof driver?.name === 'string' && driver.name.trim()) {
      toolName = driver.name.trim();
    }
    if (run.results !== undefined && run.results !== null && !Array.isArray(run.results)) {
      throw new HttpError(400, 'SARIF run 的 results 必须是数组', { code: 'sarif.resultsInvalid' });
    }
    for (const result of run.results ?? []) {
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new HttpError(400, 'SARIF results 数组的每一项必须是对象', { code: 'sarif.resultInvalid' });
      }
      if (result.ruleId !== undefined && result.ruleId !== null && typeof result.ruleId !== 'string') {
        throw new HttpError(400, 'SARIF result 的 ruleId 必须是字符串', { code: 'sarif.ruleIdInvalid' });
      }
      if (result.message !== undefined && result.message !== null
        && (typeof result.message !== 'object' || Array.isArray(result.message)
          || (result.message.text !== undefined && result.message.text !== null && typeof result.message.text !== 'string'))) {
        throw new HttpError(400, 'SARIF result 的 message.text 必须是字符串', { code: 'sarif.messageInvalid' });
      }
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
