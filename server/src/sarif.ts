import type { IssueRow, ScanRecord, Severity } from './db.js';

/**
 * SARIF 2.1.0 导出：把扫描结果映射为 GitHub Code Scanning / DefectDojo / SonarQube
 * 等工具链可消费的标准格式。只导出"当前存在"的问题（不含基线对比出的"已修复"项）。
 */

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

  // 规则去重并按首次出现排序，result.ruleIndex 指向这里
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
          SRCROOT: { description: { text: '扫描源码快照根目录' } },
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
                  uri: issue.filePath.replace(/\\/g, '/'),
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
