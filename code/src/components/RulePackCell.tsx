import { useTranslation } from 'react-i18next';
import type { IScanResult } from '@/data/scanresults';
import { usePackDisplayName } from '@/lib/packName';

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
  const { t } = useTranslation();
  const packDisplayName = usePackDisplayName();
  const names = scan.rulepacks?.map((pack) => packDisplayName(pack.name, pack.id)) ?? [];
  if (scan.rulepacks?.length) {
    return (
      <span
        className={`block truncate text-xs text-muted-foreground ${className}`}
        title={names.join('、')}
      >
        {names.length === 1
          ? names[0]
          : t('rulePackCell.multiSuffix', {
              firstName: names[0],
              count: names.length,
            })}
      </span>
    );
  }
  if (scan.rules) {
    return (
      <span
        className={`block truncate font-mono text-xs text-muted-foreground ${className}`}
        title={t('rulePackCell.legacyRulesetTitle')}
      >
        {scan.rules}
      </span>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}
