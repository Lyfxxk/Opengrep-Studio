export interface ICodeSnippet {
  /** 请求带 issueId 时服务端原样回传，缺省则无此字段 */
  issueId?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  highlightedLines: number[];
  /** 片段来源：磁盘快照文件 / 归档内文件（服务端必回，mock 样本可不带） */
  source?: 'file' | 'archive';
}

export const MOCK_CODE_SNIPPETS: ICodeSnippet[] = [
  {
    issueId: '1',
    filePath: 'src/utils/crypto.ts',
    startLine: 42,
    endLine: 48,
    content: 'function hashPassword(pwd: string) {\n  // MD5 is insecure\n  return md5(pwd);\n}',
    highlightedLines: [44],
  },
  {
    issueId: '2',
    filePath: 'src/api/user.ts',
    startLine: 15,
    endLine: 22,
    content: 'app.get("/user", (req, res) => {\n  const query = `SELECT * FROM users WHERE id=${req.params.id}`;\n  db.execute(query);\n});',
    highlightedLines: [16, 17],
  },
  {
    issueId: '3',
    filePath: 'src/config/env.ts',
    startLine: 8,
    endLine: 12,
    content: 'const config = {\n  apiKey: "sk-hardcoded-key-123",\n  debug: true,\n};',
    highlightedLines: [9],
  },
];