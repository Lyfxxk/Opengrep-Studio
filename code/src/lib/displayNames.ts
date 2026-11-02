import { useTranslation } from 'react-i18next';
import type { IConfig } from '@/data/configs';

export function useConfigDisplayName() {
  const { t } = useTranslation();
  const translate = t as (key: string) => string;
  return (config: IConfig): { name: string; description?: string } => {
    if (config.isProtected) {
      return {
        name: translate('configs.fallbackName'),
        description: translate('configs.fallbackDescription'),
      };
    }
    return { name: config.name, description: config.description };
  };
}

export function usePackDisplayName() {
  const { t } = useTranslation();
  const translate = t as (key: string, options: { defaultValue: string }) => string;
  return (name: string, packId?: string): string => {
    if (packId?.startsWith('builtin-')) {
      return translate(`packNames.${packId}`, { defaultValue: name });
    }
    return name;
  };
}
