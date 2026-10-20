import { invalidRequest } from './errors.js';

export const MAX_METRICS_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export function parseMetricsWindow(from: unknown, to: unknown): { from: Date; to: Date } {
  if (typeof from !== 'string' || !TIMESTAMP.test(from)) {
    throw invalidRequest('from', 'invalid_window', 'from must be an absolute timestamp.');
  }
  if (typeof to !== 'string' || !TIMESTAMP.test(to)) {
    throw invalidRequest('to', 'invalid_window', 'to must be an absolute timestamp.');
  }
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
    throw invalidRequest('to', 'invalid_window', 'The time window is invalid.');
  }
  if (end.getTime() - start.getTime() > MAX_METRICS_WINDOW_MS) {
    throw invalidRequest('to', 'invalid_window', 'The time window is too large.');
  }
  return { from: start, to: end };
}
