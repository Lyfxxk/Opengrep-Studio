import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { IScanResult } from '@/data/scanresults';

/** 扫描状态徽章：项目扫描历史与扫描中心共用 */
export default function ScanStatusBadge({ status }: { status: IScanResult['status'] }) {
  const { t } = useTranslation();
  if (status === 'scanning') {
    return (
      <Badge variant="outline" className="gap-1 font-normal">
        <Loader2 className="size-3 animate-spin" />
        {t('scanStatus.scanning')}
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge variant="destructive" className="gap-1 font-normal">
        <XCircle className="size-3" />
        {t('scanStatus.failed')}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1 font-normal">
      <CheckCircle2 className="size-3 text-success" />
      {t('scanStatus.completed')}
    </Badge>
  );
}
