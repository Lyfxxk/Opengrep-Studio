import { CircleAlert, CheckCircle2, CircleDot } from 'lucide-react';

/** 分页列表的默认每页条数（问题明细、项目/扫描/报告中心、自定义规则包列表共用同一口径） */
export const LIST_PAGE_SIZE = 10;

/** 规则包"适用语言"的统一候选列表（规则包上传 / 在线创建 / 实验室另存共用） */
export const PACK_LANGUAGES = [
  'Java',
  'JavaScript',
  'TypeScript',
  'Go',
  'Python',
  'C',
  'C++',
  'C#',
  'PHP',
  'Ruby',
  'Rust',
  'Kotlin',
  'Swift',
  'Dockerfile',
  'Other',
] as const;

/**
 * 对比状态（new/fixed/remaining）的统一视觉配置（扫描结果页对比卡 / 测试报告页 / 问题徽章共用）。
 * badge 用于 Badge 组件，底色透明度（/15）比卡片底色（/10）略深以保持描边内的对比度。
 */
export const COMPARISON_VISUALS: Record<
  'new' | 'fixed' | 'remaining',
  { icon: typeof CircleAlert; tone: string; bg: string; badge: string }
> = {
  new: {
    icon: CircleAlert,
    tone: 'text-destructive',
    bg: 'bg-destructive/10',
    badge: 'bg-destructive/15 text-destructive border-transparent',
  },
  fixed: {
    icon: CheckCircle2,
    tone: 'text-success',
    bg: 'bg-success/10',
    badge: 'bg-success/15 text-success border-transparent',
  },
  remaining: {
    icon: CircleDot,
    tone: 'text-warning',
    bg: 'bg-warning/10',
    badge: 'bg-warning/15 text-warning border-transparent',
  },
};
