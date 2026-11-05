import { Fragment, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Puzzle,
  Radar,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import LanguageMenu from '@/components/LanguageMenu';
import SkinMenu from '@/components/SkinMenu';
import ThemeMenu from '@/components/ThemeMenu';
import { getCurrentUser, hasRole, logout, restoreSession } from '@/lib/auth';
import { USE_MOCK, type SessionUser, type UserRole } from '@/lib/api';
import avatarUrl from '@/assets/images/avatar.jpg';
import logoUrl from '@/assets/images/logo.png';

interface Crumb {
  label: string;
  to?: string;
}

type NavKey =
  | 'nav.dashboard'
  | 'nav.projects'
  | 'nav.scans'
  | 'nav.reports'
  | 'nav.rules'
  | 'nav.configs';

const NAV_ITEMS: Array<{ path: string; label: NavKey; icon: typeof LayoutDashboard; minRole?: UserRole }> = [
  { path: '/dashboard', label: 'nav.dashboard', icon: LayoutDashboard },
  { path: '/projects', label: 'nav.projects', icon: FolderOpen },
  { path: '/scans', label: 'nav.scans', icon: Radar },
  { path: '/reports', label: 'nav.reports', icon: FileText },
  { path: '/rules', label: 'nav.rules', icon: Puzzle, minRole: 'auditor' },
  { path: '/configs', label: 'nav.configs', icon: SlidersHorizontal, minRole: 'auditor' },
];

const ICON_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function AppSidebar() {
  const { pathname } = useLocation();
  const { t } = useTranslation();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-3 group-data-[state=collapsed]:justify-center group-data-[state=collapsed]:px-0">
          <img src={logoUrl} alt="" className="size-8 shrink-0" />
          <div className="min-w-0 flex-1 group-data-[state=collapsed]:hidden">
            <div className="truncate text-sm font-semibold text-sidebar-foreground">Opengrep Studio</div>
            <div className="truncate text-xs text-sidebar-foreground/60">{t('app.tagline')}</div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="p-2.5">
          <SidebarMenu className="gap-1.5">
            {NAV_ITEMS.filter((item) => !item.minRole || hasRole(item.minRole)).map((item) => {
              const Icon = item.icon;
              const isActive =
                pathname === item.path || pathname.startsWith(`${item.path}/`);
              return (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    asChild
                    tooltip={t(item.label)}
                    isActive={isActive}
                    size="lg"
                    className="gap-3 rounded-lg px-3 text-[15px] [&>svg]:size-5"
                  >
                    <NavLink to={item.path} className="flex items-center gap-3">
                      <Icon className="size-5 shrink-0" />
                      <span className="group-data-[state=collapsed]:hidden">
                        {t(item.label)}
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

export const Layout = () => {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const [session, setSession] = useState<SessionUser | null | 'pending'>(() =>
    USE_MOCK ? getCurrentUser() ?? 'pending' : 'pending',
  );

  useEffect(() => {
    if (session !== 'pending') return;
    let cancelled = false;
    restoreSession().then((user) => {
      if (!cancelled) setSession(user);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const segments = pathname.split('/').filter(Boolean);
  const navLabel = NAV_ITEMS.find((item) => item.path === `/${segments[0]}`)?.label;
  let crumbs: Crumb[];
  if (navLabel && segments[0] !== 'projects') {
    crumbs = [{ label: t(navLabel) }];
  } else if (segments[0] === 'lab') {
    crumbs = [{ label: t('nav.rules') }];
  } else if (segments.length === 0) {
    crumbs = [{ label: t('nav.projects') }];
  } else {
    crumbs = [{ label: t('nav.projects'), to: '/projects' }];
    if (segments.length >= 2) {
      crumbs.push({ label: t('breadcrumb.projectDetail'), to: `/${segments[0]}/${segments[1]}` });
    }
    if (segments.includes('scans')) {
      const onReport = segments.includes('report');
      crumbs.push(
        onReport
          ? { label: t('breadcrumb.scanResult'), to: `/${segments.slice(0, 4).join('/')}` }
          : { label: t('breadcrumb.scanResult') },
      );
      if (onReport) crumbs.push({ label: t('breadcrumb.report') });
    }
  }

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  if (session === 'pending') {
    return null;
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="h-svh min-w-0 flex-1 flex-col overflow-x-hidden">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 md:px-6">
          <SidebarTrigger className="-ml-1" />
          <div className="h-4 w-px bg-border" />
          <Breadcrumb>
            <BreadcrumbList>
              {crumbs.map((crumb, index) => {
                const isLast = index === crumbs.length - 1;
                return (
                  <Fragment key={crumb.label}>
                    <BreadcrumbItem>
                      {isLast || !crumb.to ? (
                        <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild>
                          <Link to={crumb.to}>{crumb.label}</Link>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                    {!isLast && <BreadcrumbSeparator />}
                  </Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>

          <div className="ml-auto flex items-center gap-2">
            <ThemeMenu className={ICON_BUTTON_CLASS} />
            <LanguageMenu className={ICON_BUTTON_CLASS} />
            <SkinMenu className={ICON_BUTTON_CLASS} />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="user-menu-trigger"
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Avatar className="size-7">
                    <AvatarImage src={avatarUrl} alt={t('header.avatarAlt')} />
                    <AvatarFallback>🐹</AvatarFallback>
                  </Avatar>
                  <span className="hidden text-sm sm:inline">
                    {session.username}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                {session.role === 'admin' && !USE_MOCK && (
                  <DropdownMenuItem data-testid="user-menu-users" onSelect={() => navigate('/users')}>
                    <Users className="size-4" />
                    {t('header.userManagement')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem data-testid="user-menu-logout" onSelect={handleLogout}>
                  <LogOut className="size-4" />
                  {t('header.logout')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="w-full min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-6 lg:px-8">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
};
