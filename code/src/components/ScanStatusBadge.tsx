import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { IScanResult } from '@/data/scanresults';

/** 扫描状态徽章：项目扫描历史与扫描中心共用 */
export default function ScanStatusBadge({ status }: { status: IScanResult['status'] }) {
  if (status === 'scanning') {
    return (
      <Badge variant="outline" className="gap-1 font-normal">
        <Loader2 className="size-3 animate-spin" />
        扫描中
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge variant="destructive" className="gap-1 font-normal">
        <XCircle className="size-3" />
        失败
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1 font-normal">
      <CheckCircle2 className="size-3 text-success" />
      已完成
    </Badge>
  );
}
