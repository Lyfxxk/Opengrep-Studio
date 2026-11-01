import { Fragment } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LogOut } from 'lucide-react';
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
import LanguageMenu from '@/components/LanguageMenu';
import ThemeMenu from '@/components/ThemeMenu';
import { getCurrentUsername, logout } from '@/lib/auth';
import avatarUrl from '@/assets/images/avatar.jpg';

interface Crumb {
  label: string;
  to?: string;
}

const ICON_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export default function Header() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useTranslation();

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

  const handleLogout = () => {
    logout();
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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Avatar className="size-7">
                <AvatarImage src={avatarUrl} alt={t('header.avatarAlt')} />
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
              {t('header.logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
