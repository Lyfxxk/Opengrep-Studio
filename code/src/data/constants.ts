import { CircleAlert, CheckCircle2, CircleDot } from 'lucide-react';

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

/** 对比状态（new/fixed/remaining）的统一视觉配置（扫描结果页对比卡 / 测试报告页共用） */
export const COMPARISON_VISUALS: Record<
  'new' | 'fixed' | 'remaining',
  { icon: typeof CircleAlert; tone: string; bg: string }
> = {
  new: { icon: CircleAlert, tone: 'text-destructive', bg: 'bg-destructive/10' },
  fixed: { icon: CheckCircle2, tone: 'text-success', bg: 'bg-success/10' },
  remaining: { icon: CircleDot, tone: 'text-warning', bg: 'bg-warning/10' },
};
