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
  // 旧扫描曾把配置内部 ID（cfg-xxx）当规则集落库：内部标识对用户无意义，按无信息占位；
  // 现行配置扫描必带规则包快照（走上面分支），此处只为守住旧字段的全局展示口径
  if (scan.rules && !scan.rules.startsWith('cfg-')) {
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
