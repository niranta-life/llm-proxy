export const TOOL_ADAPTER_VERSIONS = {
  openai: 1,
  anthropic: 1,
  vertex: 1,
  xai: 1,
  openrouter: 1,
  dgx: 1,
} as const;

export type ToolProviderName = keyof typeof TOOL_ADAPTER_VERSIONS;

export type ToolAttemptAudit = {
  capabilities: readonly string[];
  adapterVersion: number;
};

export function toolAttemptAudit(provider: string, capabilities: readonly string[]): ToolAttemptAudit | null {
  if (!Object.prototype.hasOwnProperty.call(TOOL_ADAPTER_VERSIONS, provider)) return null;
  return {
    capabilities: [...capabilities],
    adapterVersion: TOOL_ADAPTER_VERSIONS[provider as ToolProviderName],
  };
}
