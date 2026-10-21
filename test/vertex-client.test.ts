import { AuthClient } from 'google-auth-library';
import { GoogleGenAI } from '@google/genai';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cachedVertexClient,
  clearVertexClientCache,
  describeVertexClientOptions,
  evictVertexClient,
  impersonatedPrincipal,
  vertexGenerateClient,
  vertexLocationBaseUrl,
  type VertexClientSpec,
  type VertexGenerateClient,
} from '../src/inference/vertex-client.js';
import { testVertexInference, validateVertexAccess, validateVertexCredential } from '../src/inference/vertex-probe.js';

const GUARDED = [
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_VERTEX_BASE_URL',
] as const;

function spec(overrides: Partial<VertexClientSpec> = {}): VertexClientSpec {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    connectionId: '22222222-2222-4222-8222-222222222222',
    connectionConfigVersion: 3,
    credentialVersion: 4,
    projectId: 'alpha-vertex-proj',
    location: 'us-central1',
    apiVersion: 'v1',
    authMode: 'adc',
    serviceAccountIdentity: null,
    credentialJson: null,
    ...overrides,
  };
}

function snapshot(): Array<string | undefined> {
  return GUARDED.map((key) => process.env[key]);
}

class HeaderAuth extends AuthClient {
  override async getRequestHeaders(): Promise<Headers> {
    return new Headers({ Authorization: 'Bearer test-token' });
  }

  override async getAccessToken(): Promise<{ token?: string | null }> {
    return { token: 'test-token' };
  }

  override async request(): Promise<never> {
    throw new Error('request was not used');
  }
}

describe('vertex client selection', () => {
  afterEach(() => {
    clearVertexClientCache();
  });

  it('selects the location host and stable API without reading the active gcloud project', () => {
    expect(vertexLocationBaseUrl('global')).toBe('https://aiplatform.googleapis.com/');
    expect(vertexLocationBaseUrl('us')).toBe('https://aiplatform.us.rep.googleapis.com/');
    expect(vertexLocationBaseUrl('europe-west4')).toBe('https://europe-west4-aiplatform.googleapis.com/');
    expect(impersonatedPrincipal('projects/alpha-vertex-proj/serviceAccounts/123456789012')).toBe('123456789012');
    const before = snapshot();
    const options = describeVertexClientOptions(spec({ apiVersion: 'v1', location: 'europe-west4', projectId: 'beta-vertex-proj' }));
    expect(options.vertexai).toBe(true);
    expect(options.project).toBe('beta-vertex-proj');
    expect(options.location).toBe('europe-west4');
    expect(options.apiVersion).toBe('v1');
    expect(options.httpOptions?.baseUrl).toBe('https://europe-west4-aiplatform.googleapis.com/');
    expect(snapshot()).toEqual(before);
  });

  it('calls the configured project and location when Google environment variables point elsewhere', async () => {
    const previous = snapshot();
    process.env.GOOGLE_CLOUD_PROJECT = 'decoy-project';
    process.env.GOOGLE_CLOUD_LOCATION = 'asia-east1';
    process.env.GOOGLE_VERTEX_BASE_URL = 'https://decoy.invalid/';
    process.env.GOOGLE_GENAI_USE_VERTEXAI = 'false';
    const seen: string[] = [];
    try {
      const options = describeVertexClientOptions(spec());
      const ai = new GoogleGenAI({
        ...options,
        googleAuthOptions: { ...options.googleAuthOptions, authClient: new HeaderAuth() },
        httpOptions: {
          baseUrl: options.httpOptions?.baseUrl,
          fetch: async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            seen.push(url);
            throw new Error('stopped');
          },
        },
      });
      await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: 'hi' }).catch(() => undefined);
    } finally {
      GUARDED.forEach((key, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain('https://us-central1-aiplatform.googleapis.com/');
    expect(seen[0]).toContain('alpha-vertex-proj');
    expect(seen[0]).toContain('/v1/');
    expect(seen[0]).not.toContain('decoy');
    expect(seen[0]).not.toContain('asia-east1');
    expect(snapshot()).toEqual(previous);
  });

  it('checks access on the configured project and location', async () => {
    const seen: string[] = [];
    const value = spec({ projectId: 'probe-vertex-proj', location: 'global' });
    const options = describeVertexClientOptions(value);
    const ai = new GoogleGenAI({
      ...options,
      googleAuthOptions: { ...options.googleAuthOptions, authClient: new HeaderAuth() },
      httpOptions: {
        baseUrl: options.httpOptions?.baseUrl,
        fetch: async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          seen.push(url);
          throw new Error('stopped');
        },
      },
    });
    const client = vertexGenerateClient(ai);
    await expect(validateVertexAccess(client, value)).rejects.toThrow(/stopped/);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain('https://aiplatform.googleapis.com/');
    expect(seen[0]).toContain('/v1/projects/probe-vertex-proj/locations/global/models');
    expect(seen[0]).not.toContain('publishers/google/models');
  });

  it('refreshes a cached client by tenant, connection, and config version', async () => {
    const minted: string[] = [];
    const client = { generateContent: async () => ({}), generateContentStream: async () => [], listModels: async () => undefined };
    let now = 1_000_000;
    const mint = async (value: VertexClientSpec) => {
      minted.push(`${value.tenantId}:${value.projectId}:${value.connectionConfigVersion}`);
      return { client, expiresAtMs: now + 10 * 60_000 };
    };
    const first = await cachedVertexClient(spec(), { now: () => now, mint });
    const second = await cachedVertexClient(spec(), { now: () => now + 1_000, mint });
    expect(second).toBe(first);
    now += 10 * 60_000 - 30_000;
    await cachedVertexClient(spec(), { now: () => now, mint });
    const other = spec({ tenantId: '33333333-3333-4333-8333-333333333333', projectId: 'beta-vertex-proj' });
    await cachedVertexClient(other, { now: () => now, mint });
    evictVertexClient(spec());
    await cachedVertexClient(spec(), { now: () => now, mint });
    expect(minted).toEqual([
      '11111111-1111-4111-8111-111111111111:alpha-vertex-proj:3',
      '11111111-1111-4111-8111-111111111111:alpha-vertex-proj:3',
      '33333333-3333-4333-8333-333333333333:beta-vertex-proj:3',
      '11111111-1111-4111-8111-111111111111:alpha-vertex-proj:3',
    ]);
  });

  it('validates a credential, project access, and a small inference without returning hidden text', async () => {
    const value = spec({ projectId: 'probe-vertex-proj', location: 'global' });
    const credential = await validateVertexCredential(value, {
      mint: async () => ({ client: unusedClient(), expiresAtMs: Date.now() + 60_000 }),
    });
    expect(credential).toEqual({ status: 'valid', projectId: 'probe-vertex-proj', location: 'global' });
    let listed = false;
    const client: VertexGenerateClient = {
      async generateContent(request) {
        expect(request.contents[0]?.parts[0]?.text).toBe('Reply with ok.');
        expect(request.config.maxOutputTokens).toBe(8);
        expect(request.config.automaticContinuation).toBe(false);
        return {
          responseId: 'probe-1',
          modelVersion: 'gemini-probe',
          candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'hidden' }, { text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
        };
      },
      generateContentStream() {
        return [];
      },
      async listModels() {
        listed = true;
      },
    };
    const access = await validateVertexAccess(client, value);
    expect(listed).toBe(true);
    expect(access.location).toBe('global');
    const inference = await testVertexInference(client, 'gemini-2.5-flash');
    expect(inference.text).toBe('ok');
    expect(inference.model).toBe('gemini-probe');
    expect(JSON.stringify(inference)).not.toContain('hidden');
    expect(inference.providerRequestId).toBe('probe-1');
  });
});

function unusedClient(): VertexGenerateClient {
  return {
    async generateContent() {
      return {};
    },
    generateContentStream() {
      return [];
    },
    async listModels() {},
  };
}
