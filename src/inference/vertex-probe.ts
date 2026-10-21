import type { VertexClientSpec, VertexGenerateClient } from './vertex-client.js';
import { mintVertexClient } from './vertex-client.js';
import { normalizeVertexResponse } from './vertex-convert.js';

const PROBE_TEXT = 'Reply with ok.';

export async function validateVertexCredential(
  spec: VertexClientSpec,
  deps: { mint?: typeof mintVertexClient } = {},
): Promise<{ status: 'valid'; projectId: string; location: string }> {
  const mint = deps.mint ?? mintVertexClient;
  await mint(spec);
  return { status: 'valid', projectId: spec.projectId, location: spec.location };
}

export async function validateVertexAccess(
  client: VertexGenerateClient,
  spec: { projectId: string; location: string },
  signal?: AbortSignal,
): Promise<{ status: 'valid'; projectId: string; location: string }> {
  await client.listModels(signal);
  return { status: 'valid', projectId: spec.projectId, location: spec.location };
}

export async function testVertexInference(
  client: VertexGenerateClient,
  upstreamModel: string,
  signal?: AbortSignal,
): Promise<{
  status: 'valid';
  model: string;
  text: string;
  finishReason: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null };
  thoughtsTokens: number | null;
  providerRequestId: string | null;
}> {
  const response = await client.generateContent({
    model: upstreamModel,
    contents: [{ role: 'user', parts: [{ text: PROBE_TEXT }] }],
    config: { maxOutputTokens: 8, temperature: 0, automaticContinuation: false, abortSignal: signal },
  });
  const normalized = normalizeVertexResponse(response, Math.floor(Date.now() / 1000), upstreamModel);
  const choice = normalized.response.choices[0];
  return {
    status: 'valid',
    model: normalized.response.model,
    text: choice?.message.content ?? '',
    finishReason: choice?.finish_reason ?? null,
    usage: normalized.usage,
    thoughtsTokens: normalized.thoughtsTokens ?? null,
    providerRequestId: normalized.providerRequestId,
  };
}
