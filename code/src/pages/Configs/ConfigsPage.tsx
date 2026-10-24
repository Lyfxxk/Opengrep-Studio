import ScanConfigTab from './ScanConfigTab';

/** 扫描配置：规则包勾选 + 路径过滤 + 引擎参数，绑定到项目后生效 */
export default function ConfigsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">扫描配置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          维护规则包勾选、路径过滤与引擎参数，绑定到项目后扫描按配置执行
        </p>
      </div>
      <ScanConfigTab />
    </div>
  );
}
