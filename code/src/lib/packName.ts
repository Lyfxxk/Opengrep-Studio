import { useTranslation } from 'react-i18next';

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
