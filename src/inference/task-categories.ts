export const TASK_CATEGORIES = [
  'classification',
  'extraction',
  'summarization',
  'reasoning',
  'coding',
  'translation',
  'writing',
  'general_qa',
  'unknown',
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(TASK_CATEGORIES);

export function isTaskCategory(value: string): value is TaskCategory {
  return CATEGORY_SET.has(value);
}
