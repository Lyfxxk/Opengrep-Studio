import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import RulePackTab from '@/pages/Configs/RulePackTab';
import LabPage from '@/pages/Lab/LabPage';

export default function RulesCenterPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'lab' ? 'lab' : 'packs';

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{t('nav.rules')}</h1>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              if (value === 'lab') next.set('tab', 'lab');
              else next.delete('tab');
              return next;
            },
            { replace: true },
          );
        }}
      >
        <TabsList>
          <TabsTrigger value="packs">{t('rulesCenter.tabPacks')}</TabsTrigger>
          <TabsTrigger value="lab">{t('rulesCenter.tabLab')}</TabsTrigger>
        </TabsList>
        <TabsContent value="packs" className="mt-4">
          <RulePackTab />
        </TabsContent>
        <TabsContent value="lab" className="mt-4">
          <LabPage />
        </TabsContent>
      </Tabs>
    </div>
  );
}
