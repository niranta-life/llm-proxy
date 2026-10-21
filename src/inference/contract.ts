import type { UpstreamCompletion } from './adapter.js';
import type { ResolvedRoute } from './resolve.js';
import type { ChatRequest } from './validate.js';
import type { VertexClientFactory } from './vertex-client.js';

export type ProviderName = 'openai' | 'anthropic';

export type RegistryProviderName = ProviderName | 'vertex' | 'xai' | 'openrouter' | 'dgx';

export type CanonicalTextRequest = ChatRequest;

export type CanonicalTextCompletion = UpstreamCompletion['response'];

export type ProviderCall = {
  apiKey: string;
  baseURL: string;
  request: ChatRequest;
  route: ResolvedRoute;
  signal: AbortSignal;
  tenantId: string;
  vertexClientFactory?: VertexClientFactory;
  fetchImpl?: typeof fetch;
};

export type ProviderAdapter = {
  readonly provider: RegistryProviderName;
  prepare(request: ChatRequest, route: ResolvedRoute): void;
  execute(call: ProviderCall): Promise<UpstreamCompletion>;
};
