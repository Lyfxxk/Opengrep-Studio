import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { NAV_ITEMS } from '@/components/AppSidebar';
import { getCurrentUsername, logout } from '@/lib/auth';
import avatarUrl from '@/assets/images/avatar.jpg';

/** 每级面包屑带可选跳转地址；末级固定为当前页（不可点） */
interface Crumb {
  label: string;
  to?: string;
}

export default function Header() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const segments = pathname.split('/').filter(Boolean);
  // 一级面包屑标签与侧栏导航同源；实验室挂在规则中心下，路由名与导航项不同名
  const navLabel = NAV_ITEMS.find((item) => item.path === `/${segments[0]}`)?.label;
  let crumbs: Crumb[];
  if (navLabel && segments[0] !== 'projects') {
    crumbs = [{ label: navLabel }];
  } else if (segments[0] === 'lab') {
    crumbs = [{ label: '规则中心' }];
  } else if (segments.length === 0) {
    crumbs = [{ label: '项目管理' }];
  } else {
    crumbs = [{ label: '项目管理', to: '/projects' }];
    if (segments.length >= 2) {
      crumbs.push({ label: '项目详情', to: `/${segments[0]}/${segments[1]}` });
    }
    if (segments.includes('scans')) {
      // 报告页时“扫描结果”可点击返回，并追加“测试报告”末级面包屑
      const onReport = segments.includes('report');
      crumbs.push(
        onReport
          ? { label: '扫描结果', to: `/${segments.slice(0, 4).join('/')}` }
          : { label: '扫描结果' },
      );
      if (onReport) crumbs.push({ label: '测试报告' });
    }
  }

  const handleLogout = () => {
    logout();
    toast.success('已退出登录');
    navigate('/login');
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 md:px-6">
      <SidebarTrigger className="-ml-1" />
      <div className="h-4 w-px bg-border" />
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            return (
              <BreadcrumbItem key={crumb.label}>
                {isLast || !crumb.to ? (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                ) : (
                  <>
                    <BreadcrumbLink asChild>
                      <Link to={crumb.to}>{crumb.label}</Link>
                    </BreadcrumbLink>
                    <BreadcrumbSeparator>
                      <ChevronRight className="size-3.5" />
                    </BreadcrumbSeparator>
                  </>
                )}
              </BreadcrumbItem>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Avatar className="size-7">
                <AvatarImage src={avatarUrl} alt="管理员头像" />
                <AvatarFallback>🐹</AvatarFallback>
              </Avatar>
              <span className="hidden text-sm sm:inline">
                {getCurrentUsername()}
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={handleLogout}>
              <LogOut className="size-4" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
