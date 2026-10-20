#!/usr/bin/env node
// Optional operator check. npm test does not run this file.
// It exits without a network call unless OPENAI_STREAM_SMOKE=1.

import { spawn } from 'node:child_process';
import OpenAI from 'openai';

if (process.env.OPENAI_STREAM_SMOKE !== '1') {
  process.stderr.write('OpenAI stream smoke test is off. Set OPENAI_STREAM_SMOKE=1 to send one streaming chat.\n');
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

const endpoint = new URL('/v1/chat/completions', baseUrl).toString();
const payload = JSON.stringify({
  model,
  messages: [{ role: 'user', content: 'smoke' }],
  stream: true,
});

const curl = spawn(
  'curl',
  [
    '-N',
    '-sS',
    '-D',
    '-',
    '-o',
    '-',
    '-X',
    'POST',
    endpoint,
    '-H',
    'content-type: application/json',
    '-H',
    `X-Tenant-ID: ${tenantId}`,
    '-H',
    `Authorization: Bearer ${tenantSecret}`,
    '--data-binary',
    payload,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let curlText = '';
curl.stdout.on('data', (chunk) => {
  curlText += String(chunk);
});
curl.stderr.on('data', (chunk) => {
  curlText += String(chunk);
});
const curlCode = await new Promise((resolve) => {
  curl.once('exit', (code) => resolve(code ?? 1));
});

const events = curlText
  .split(/\r?\n\r?\n/)
  .map((block) => block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
  .filter((data) => data.length > 0);
const doneCount = events.filter((data) => data === '[DONE]').length;
const chunks = events.filter((data) => data !== '[DONE]').map((data) => JSON.parse(data));
const curlSummary = {
  tool: 'curl',
  exitCode: curlCode,
  statusLine: curlText.split(/\r?\n/).find((line) => line.startsWith('HTTP/')) ?? null,
  chunkCount: chunks.length,
  doneCount,
  object: chunks[0]?.object ?? null,
  id: chunks[0]?.id ?? null,
  model: chunks[0]?.model ?? null,
  role: chunks[0]?.choices?.[0]?.delta?.role ?? null,
  finishReason: chunks.map((chunk) => chunk.choices?.[0]?.finish_reason).find((reason) => reason) ?? null,
};

const client = new OpenAI({
  apiKey: tenantSecret,
  baseURL: new URL('/v1', baseUrl).toString(),
  maxRetries: 0,
  defaultHeaders: { 'X-Tenant-ID': tenantId },
});
const stream = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: 'smoke' }],
  stream: true,
  stream_options: { include_usage: true },
});
let sdkChunks = 0;
let sdkId = null;
let sdkModel = null;
let sdkRole = null;
let sdkFinish = null;
let sdkUsage = null;
for await (const chunk of stream) {
  sdkChunks += 1;
  sdkId = sdkId ?? chunk.id;
  sdkModel = sdkModel ?? chunk.model;
  sdkRole = sdkRole ?? chunk.choices[0]?.delta?.role ?? null;
  if (chunk.choices[0]?.finish_reason) sdkFinish = chunk.choices[0].finish_reason;
  if (chunk.usage) sdkUsage = chunk.usage;
}

const summary = {
  curl: curlSummary,
  sdk: {
    chunkCount: sdkChunks,
    id: sdkId,
    model: sdkModel,
    role: sdkRole,
    finishReason: sdkFinish,
    usage: sdkUsage,
  },
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exit(curlCode === 0 && doneCount === 1 && sdkChunks > 0 ? 0 : 1);
