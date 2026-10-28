import { useTranslation } from 'react-i18next';
import ScanConfigTab from './ScanConfigTab';

/** 扫描配置：规则包勾选 + 路径过滤 + 引擎参数，绑定到项目后生效 */
export default function ConfigsPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t('configs.pageTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('configs.pageSubtitle')}</p>
      </div>
      <ScanConfigTab />
    </div>
  );
}
