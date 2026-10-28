import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ErrorBoundary } from "react-error-boundary";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
// 初始化 i18n（react-i18next 全局实例，需先于组件树求值）
import "@/i18n";
import i18n from "@/i18n";
import App from "./app";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      {/* 全局常驻吐司容器：挂在路由外，避免随页面卸载导致吐司滞留/迟到 */}
      <Toaster richColors position="top-center" />
      <ErrorBoundary
        fallbackRender={({ error, resetErrorBoundary }) => (
          <div
            role="alert"
            className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center"
          >
            <h1 className="text-lg font-semibold">{i18n.t('errorBoundary.title')}</h1>
            <p className="max-w-md text-sm text-muted-foreground">
              {error instanceof Error ? error.message : String(error)}
            </p>
            <Button onClick={resetErrorBoundary}>{i18n.t('errorBoundary.retry')}</Button>
          </div>
        )}
      >
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
