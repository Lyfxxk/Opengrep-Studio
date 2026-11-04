import { Link, Navigate, Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Layout } from "@/components/Layout";
import LoginPage from "@/pages/Login/LoginPage";
import DashboardPage from "@/pages/Dashboard/DashboardPage";
import ProjectsPage from "@/pages/Projects/ProjectsPage";
import ProjectDetailPage from "@/pages/ProjectDetail/ProjectDetailPage";
import ScanResultPage from "@/pages/ScanResult/ScanResultPage";
import ReportPage from "@/pages/Report/ReportPage";
import ScansCenterPage from "@/pages/Scans/ScansCenterPage";
import ReportsCenterPage from "@/pages/Reports/ReportsCenterPage";
import RulesCenterPage from "@/pages/Rules/RulesCenterPage";
import ScanConfigTab from "@/pages/Configs/ScanConfigTab";
import UsersPage from "@/pages/Users/UsersPage";
import { getCurrentUser } from "@/lib/auth";
import { USE_MOCK } from "@/lib/api";

function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-24">
      <h1 className="text-6xl font-bold mb-4">404</h1>
      <p className="text-lg text-muted-foreground mb-8">{t('notFound.text')}</p>
      <Link to="/projects" className="text-primary hover:underline">{t('common.backToProjects')}</Link>
    </div>
  );
}

function RequireAdmin() {
  const user = getCurrentUser();
  if (USE_MOCK || !user || user.role !== 'admin') {
    return <Navigate to="/dashboard" replace />;
  }
  return <UsersPage />;
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="projects/:id/scans/:scanId" element={<ScanResultPage />} />
        <Route path="projects/:id/scans/:scanId/report" element={<ReportPage />} />
        <Route path="scans" element={<ScansCenterPage />} />
        <Route path="reports" element={<ReportsCenterPage />} />
        <Route path="rules" element={<RulesCenterPage />} />
        <Route path="lab" element={<Navigate to="/rules?tab=lab" replace />} />
        <Route path="configs" element={<ScanConfigTab />} />
        <Route path="users" element={<RequireAdmin />} />
      </Route>
      <Route path="login" element={<LoginPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
