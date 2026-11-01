import { useTranslation } from 'react-i18next';
import ScanConfigTab from './ScanConfigTab';

export default function ConfigsPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{t('configs.pageTitle')}</h1>
      <ScanConfigTab />
    </div>
  );
}
