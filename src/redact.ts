const SENSITIVE_KEY = /(authorization|password|secret|token|verifier|credential|api[-_]?key|messages|prompt)/i;

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/yck_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/scrypt\$[A-Za-z0-9_$.-]+/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/aes-256-gcm\$[A-Za-z0-9_$-]+/g, '[REDACTED]');
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 20) return '[REDACTED]' as T;
  if (typeof value === 'string') return redactString(value) as T;
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString() as T;
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1)) as T;
  }
  if (typeof value === 'object') {
    if (value instanceof Error) return redact(value.message, depth + 1) as T;
    const output: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(inner, depth + 1);
    }
    return output as T;
  }
  return value;
}
