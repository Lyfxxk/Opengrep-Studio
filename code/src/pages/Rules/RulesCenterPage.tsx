import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import RulePackTab from '@/pages/Configs/RulePackTab';
import LabPage from '@/pages/Lab/LabPage';

/** 规则中心：规则包库与规则实验室——管规则、写规则、带测试分发 */
export default function RulesCenterPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'lab' ? 'lab' : 'packs';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">规则中心</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理规则包（内置 / 自建 / 导入导出 / 质量检查），或在规则实验室在线验证规则正反例
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          // 仅实验室 tab 进 URL：规则包为默认态保持地址干净，实验室可被直接分享 / 收藏
          setSearchParams(value === 'lab' ? { tab: 'lab' } : {}, { replace: true });
        }}
      >
        <TabsList>
          <TabsTrigger value="packs">规则包</TabsTrigger>
          <TabsTrigger value="lab">规则实验室</TabsTrigger>
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
