import type { IScanResult } from '@/data/scanresults';

/**
 * 扫描表格的「规则包」单元格三态展示：
 * 规则包快照（多包时截断为「首包名 等 N 个」）/ 旧式规则集目录 / 无信息占位。
 */
export default function RulePackCell({
  scan,
  className = 'max-w-[200px]',
}: {
  scan: IScanResult;
  className?: string;
}) {
  if (scan.rulepacks?.length) {
    return (
      <span
        className={`block truncate text-xs text-muted-foreground ${className}`}
        title={scan.rulepacks.map((pack) => pack.name).join('、')}
      >
        {scan.rulepacks.length === 1
          ? scan.rulepacks[0].name
          : `${scan.rulepacks[0].name} 等 ${scan.rulepacks.length} 个`}
      </span>
    );
  }
  if (scan.rules) {
    return (
      <span className={`block truncate font-mono text-xs text-muted-foreground ${className}`} title="旧式规则集目录扫描">
        {scan.rules}
      </span>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}
