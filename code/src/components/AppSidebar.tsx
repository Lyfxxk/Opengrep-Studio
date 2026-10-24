import { NavLink, useLocation } from 'react-router-dom';
import { FileText, FolderOpen, LayoutDashboard, Puzzle, Radar, SlidersHorizontal } from 'lucide-react';
import logoUrl from '@/assets/images/logo.png';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

const NAV_ITEMS = [
  { path: '/dashboard', label: '仪表看盘', icon: LayoutDashboard },
  { path: '/projects', label: '项目管理', icon: FolderOpen },
  { path: '/scans', label: '扫描中心', icon: Radar },
  { path: '/reports', label: '报告中心', icon: FileText },
  { path: '/rules', label: '规则中心', icon: Puzzle },
  { path: '/configs', label: '扫描配置', icon: SlidersHorizontal },
];

export default function AppSidebar() {
  const { pathname } = useLocation();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-3 group-data-[state=collapsed]:justify-center group-data-[state=collapsed]:px-0">
          <img src={logoUrl} alt="" className="size-8 shrink-0" />
          <div className="min-w-0 flex-1 group-data-[state=collapsed]:hidden">
            <div className="truncate text-sm font-semibold text-sidebar-foreground">Opengrep Studio</div>
            <div className="truncate text-xs text-sidebar-foreground/60">码审工作台</div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="p-2.5">
          <SidebarMenu className="gap-1.5">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive =
                pathname === item.path || pathname.startsWith(`${item.path}/`);
              return (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    asChild
                    tooltip={item.label}
                    isActive={isActive}
                    size="lg"
                    className="gap-3 rounded-lg px-3 text-[15px] [&>svg]:size-5"
                  >
                    <NavLink to={item.path} className="flex items-center gap-3">
                      <Icon className="size-5 shrink-0" />
                      <span className="group-data-[state=collapsed]:hidden">
                        {item.label}
                      </span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div
          className="flex h-8 items-center justify-center rounded-lg bg-sidebar-foreground/10 text-xs font-medium tabular-nums text-sidebar-foreground/60"
          title={`Opengrep Studio v${__APP_VERSION__}`}
        >
          <span className="group-data-[state=collapsed]:hidden">v{__APP_VERSION__}</span>
          <span className="size-1.5 rounded-full bg-sidebar-foreground/40 group-data-[state=expanded]:hidden" />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
