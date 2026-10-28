import { Navigate, Outlet } from 'react-router-dom';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import AppSidebar from '@/components/AppSidebar';
import Header from '@/components/Header';
import { isAuthenticated } from '@/lib/auth';

export const Layout = () => {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      {/* h-svh 把高度链钉死在视口上：main 的 overflow-y-auto 才能真正生效（内滚而非撑高整页），
          页面里 h-full / grid minmax(0,1fr) 也才有确定的百分比基准 */}
      <SidebarInset className="h-svh min-w-0 flex-1 flex-col overflow-x-hidden">
        <Header />
        <main className="w-full min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-6 lg:px-8">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
};
