import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/Layout";
import NotFoundPage from "@/pages/NotFoundPage/NotFoundPage";
import LoginPage from "@/pages/Login/LoginPage";
import DashboardPage from "@/pages/Dashboard/DashboardPage";
import ProjectsPage from "@/pages/Projects/ProjectsPage";
import ProjectDetailPage from "@/pages/ProjectDetail/ProjectDetailPage";
import ScanResultPage from "@/pages/ScanResult/ScanResultPage";
import ReportPage from "@/pages/Report/ReportPage";
import ScansCenterPage from "@/pages/Scans/ScansCenterPage";
import ReportsCenterPage from "@/pages/Reports/ReportsCenterPage";
import RulesCenterPage from "@/pages/Rules/RulesCenterPage";
import ConfigsPage from "@/pages/Configs/ConfigsPage";

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
        {/* 旧路径兼容：规则实验室并入规则中心 */}
        <Route path="lab" element={<Navigate to="/rules?tab=lab" replace />} />
        <Route path="configs" element={<ConfigsPage />} />
      </Route>
      <Route path="login" element={<LoginPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

