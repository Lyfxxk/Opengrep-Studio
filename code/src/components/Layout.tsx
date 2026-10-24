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
      <SidebarInset className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
        <Header />
        <main className="w-full flex-1 overflow-y-auto px-4 py-6 md:px-6 lg:px-8">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
};
