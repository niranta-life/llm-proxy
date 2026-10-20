export type DeploymentCandidate = {
  id: string;
  name: string;
  upstreamModel: string;
  timeoutMs: number;
  capabilities: readonly string[];
  configVersion: number;
  connectionId: string;
  connectionVersion: number;
  enabled: boolean;
  connectionEnabled: boolean;
};

export type AliasCandidate = {
  alias: string;
  deploymentId: string;
};

export type ResolvedRoute = {
  requestedModel: string;
  deploymentId: string;
  deploymentName: string;
  upstreamModel: string;
  timeoutMs: number;
  capabilities: readonly string[];
  configVersion: number;
  connectionId: string;
  connectionVersion: number;
};

export function resolveModel(
  requestedModel: string,
  deployments: readonly DeploymentCandidate[],
  aliases: readonly AliasCandidate[],
): ResolvedRoute | null {
  const alias = aliases.find((item) => item.alias === requestedModel);
  const deployment = alias
    ? deployments.find((item) => item.id === alias.deploymentId)
    : deployments.find((item) => item.name === requestedModel);
  if (deployment === undefined || !deployment.enabled || !deployment.connectionEnabled) return null;
  return {
    requestedModel,
    deploymentId: deployment.id,
    deploymentName: deployment.name,
    upstreamModel: deployment.upstreamModel,
    timeoutMs: deployment.timeoutMs,
    capabilities: deployment.capabilities,
    configVersion: deployment.configVersion,
    connectionId: deployment.connectionId,
    connectionVersion: deployment.connectionVersion,
  };
}
