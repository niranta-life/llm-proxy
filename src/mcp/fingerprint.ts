import { createHash } from 'node:crypto';

export type FingerprintTool = {
  remoteName: string;
  namespacedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stable(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function catalogFingerprint(tools: readonly FingerprintTool[]): string {
  const ordered = [...tools].sort((left, right) =>
    left.namespacedName < right.namespacedName ? -1 : left.namespacedName > right.namespacedName ? 1 : 0,
  );
  const body = ordered.map((tool) => ({
    description: tool.description,
    inputSchema: tool.inputSchema,
    namespacedName: tool.namespacedName,
    outputSchema: tool.outputSchema,
    remoteName: tool.remoteName,
  }));
  return createHash('sha256').update(stable(body)).digest('hex');
}
