import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import RulePackTab from '@/pages/Configs/RulePackTab';
import LabPage from '@/pages/Lab/LabPage';

/** 规则中心：规则包库与规则实验室——管规则、写规则、带测试分发 */
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
          // 仅实验室 tab 进 URL：规则包为默认态保持地址干净，实验室可被直接分享 / 收藏
          // 只增删 tab 这一个键：整体覆盖会把 ?pack=<id> 深链一起清掉，用户从实验室点回规则包就再也找不到那只包
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
