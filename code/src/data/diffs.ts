import type { ReviewStatus, IIssue } from './issues';

export interface IReviewRecord {
  projectId: string;
  fingerprint: string;
  status: ReviewStatus;
  reason?: string;
  reviewer?: string;
  updatedAt: string;
}

export interface IReportReviewStats {
  reviewed: number;
  confirmed: number;
  falsePositives: number;
  accepted: number;
}

export interface IScanDiffIssueList {
  count: number;
  items: Array<{
    ruleId: string;
    severity: IIssue['severity'];
    filePath: string;
    startLine: number;
    message: string;
  }>;
}

export interface IScanDiff {
  scanId: string;
  against: {
    id: string;
    projectId: string;
    projectName: string;
    scannedAt: string;
  };
  issueDiff: {
    new: IScanDiffIssueList;
    fixed: IScanDiffIssueList;
    remaining: IScanDiffIssueList;
  };
  fileDiff: {
    filesA: number;
    filesB: number;
    added: string[];
    removed: string[];
    modified: Array<{
      path: string;
      addedLines: number | null;
      removedLines: number | null;
      diffable: boolean;
    }>;
  };
}

interface IKnowledgeCwe {
  id: string;
  name?: string;
  fix?: string;
}

export interface IKnowledgeSample {
  name: string;
  content: string;
}

export interface IRuleKnowledge {
  ruleId: string;
  matchedRuleId?: string;
  found: boolean;
  pack?: { id: string; name: string; builtin: boolean };
  zhMessage?: string;
  severity?: string;
  securitySeverity?: number;
  cwe: IKnowledgeCwe[];
  owasp: string[];
  fixSuggestion?: string;
  upstreamUrl?: string;
  samples?: { positives: IKnowledgeSample[]; negatives: IKnowledgeSample[] };
  stats: { total: number; projects: number; lastSeen?: string };
}

