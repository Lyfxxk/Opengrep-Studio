# Opengrep Studio 前端（code/）

React 19 + TypeScript + Vite 8 + Tailwind CSS v4，UI 组件基于 shadcn/ui（Radix primitives）。

## 启动与构建

```bash
npm run dev        # 开发模式，端口 1022，/api 代理到 http://localhost:8787 后端
npm run build      # 生产构建，产物输出到 dist/（由后端在 8787 托管）
npm run typecheck  # TypeScript 类型检查
npm run lint       # 类型检查 + ESLint
```

日常开发请在仓库根目录执行 `npm run dev`，前后端一起启动。

## 目录结构

```
src/
├── index.tsx           # 入口：挂载根组件，配置 BrowserRouter 与全局 ErrorBoundary
├── app.tsx             # 路由表（dashboard、projects、projects/:id、scans、reports、rules、configs、login 等）
├── index.css           # 全局样式 + 主题 CSS 变量（@theme inline 注册到 Tailwind）
├── components/
│   ├── Layout.tsx      # 全局布局壳（侧边栏 + 顶栏 + <Outlet />）
│   ├── AppSidebar.tsx  # 左侧导航
│   ├── Header.tsx      # 顶栏（面包屑、当前用户）
│   ├── LanguageStatsBar.tsx  # 源码语言分布条（上传后展示）
│   ├── ScanStatusBadge.tsx   # 扫描状态徽章（扫描历史 / 扫描中心）
│   └── ui/             # shadcn/ui 基础组件（生成物，勿手改；仅保留实际使用的组件）
├── pages/              # 业务页面，每个页面一个目录
│   ├── Login/          # 登录页（本地页面级门禁）
│   ├── Dashboard/      # 仪表盘（默认首页）
│   ├── Projects/       # 项目列表
│   ├── ProjectDetail/  # 项目详情（源码导入：上传压缩包 / 拖文件夹 / Git 仓库克隆，扫描历史）
│   ├── ScanResult/     # 扫描结果（问题列表、代码片段、基线对比、人工复核）
│   ├── Report/         # 测试报告（在线查看 / 打印导出 / 下载 HTML）
│   ├── Scans/          # 扫描中心（全项目扫描列表）
│   ├── Reports/        # 报告中心（全项目报告列表）
│   ├── Rules/          # 规则中心（规则包管理 + 内嵌规则实验室 Tab；/lab 旧路径重定向至此）
│   ├── Lab/            # 规则实验室页面组件（由 Rules/ 作为 Tab 挂载，无独立路由）
│   ├── Configs/        # 配置管理（扫描配置）
│   └── NotFoundPage/   # 404
├── data/               # 领域类型定义 + 演示模式（VITE_USE_MOCK）示例数据（IProject、IRulePack 等）
├── lib/                # 基础设施：api.ts 请求客户端、auth 登录态、storage 缓存
├── hooks/              # 通用 React Hooks
└── assets/images/      # 随代码打包的静态图片
```

## 开发约定

- 路由在 `app.tsx` 的 `<Routes>` 内注册；`BrowserRouter` 已在 `index.tsx` 配置，`app.tsx` 禁止再包一层 Router。
- 所有后端请求统一走 `src/lib/api.ts` 的 `api` 对象，组件内不要直接 `fetch('/api/...')`。
- 领域类型放 `src/data/`；页面专属组件放在对应 `pages/<Page>/` 目录下。
- 路径别名：`@/` → `src/`（vite.config.ts 与 tsconfig 已同步配置）。
- 静态图片放 `src/assets/images/`，通过 `import img from '@/assets/images/xxx.jpg'` 引用。
- `src/components/ui/**` 是 shadcn/ui 生成的基础组件，业务代码只引用不修改；需要新的基础组件时用 CLI 生成后按需补充对应依赖。
