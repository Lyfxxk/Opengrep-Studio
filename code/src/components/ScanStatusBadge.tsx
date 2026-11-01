import { useTranslation } from 'react-i18next';
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { IScanResult } from '@/data/scanresults';

export default function ScanStatusBadge({
  status,
  queued,
}: {
  status: IScanResult['status'];
  queued?: boolean;
}) {
  const { t } = useTranslation();
  if (status === 'scanning') {
    if (queued) {
      return (
        <Badge variant="outline" className="gap-1 font-normal">
          <Clock className="size-3" />
          {t('scanStatus.queued')}
        </Badge>
      );
    }
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
