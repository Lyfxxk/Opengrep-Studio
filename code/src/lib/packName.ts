import { useTranslation } from 'react-i18next';

/**
 * 内置规则包名的三语显示：内置包 id 固定为 `builtin-<语言>`（对应 server/rules/security/*.yaml），
 * 翻译缺失时回落到快照里的原始名（自定义包永远显示原始名）。
 * key 需要一次断言：内置包 id 集合由服务端目录决定，前端不维护白名单，缺失翻译由 defaultValue 兜底。
 */
export function usePackDisplayName() {
  const { t } = useTranslation();
  // 严格资源类型下动态键过不了 TKey 校验：这里收窄为 (key, defaultValue) 签名，缺失翻译由 defaultValue 兜底
  const translate = t as (key: string, options: { defaultValue: string }) => string;
  return (name: string, packId?: string): string => {
    if (packId?.startsWith('builtin-')) {
      return translate(`packNames.${packId}`, { defaultValue: name });
    }
    return name;
  };
}
