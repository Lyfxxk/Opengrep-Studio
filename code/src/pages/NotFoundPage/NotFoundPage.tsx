import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-24">
      <h1 className="text-6xl font-bold mb-4">404</h1>
      <p className="text-lg text-muted-foreground mb-8">{t('notFound.text')}</p>
      <Link to="/projects" className="text-primary hover:underline">{t('common.backToProjects')}</Link>
    </div>
  );
}
