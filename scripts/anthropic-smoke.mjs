#!/usr/bin/env node
// Optional operator check. npm test does not run this file.
// It exits without a network call unless ANTHROPIC_SMOKE=1.

if (process.env.ANTHROPIC_SMOKE !== '1') {
  process.stderr.write('Anthropic smoke test is off. Set ANTHROPIC_SMOKE=1 to send one chat completion.\n');
  process.exit(0);
}

const baseUrl = process.env.PROXY_BASE_URL ?? '';
const tenantId = process.env.TENANT_ID ?? '';
const tenantSecret = process.env.TENANT_SECRET ?? '';
const model = process.env.MODEL ?? '';
if (baseUrl.length === 0 || tenantId.length === 0 || tenantSecret.length === 0 || model.length === 0) {
  process.stderr.write('PROXY_BASE_URL, TENANT_ID, TENANT_SECRET, and MODEL are required.\n');
  process.exit(1);
}

const response = await fetch(new URL('/v1/chat/completions', baseUrl), {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-tenant-id': tenantId,
    authorization: `Bearer ${tenantSecret}`,
  },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'smoke' }],
  }),
});
const body = await response.json();
const choice = body.choices?.[0];
const summary = {
  status: response.status,
  id: typeof body.id === 'string' ? body.id : null,
  model: typeof body.model === 'string' ? body.model : null,
  finishReason: choice?.finish_reason ?? null,
  usage: body.usage ?? null,
  errorCode: body.error?.code ?? null,
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exit(response.ok ? 0 : 1);
