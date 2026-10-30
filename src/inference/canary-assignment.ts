import { createHash, createHmac, randomBytes } from 'node:crypto';
import { invalidRequest } from './errors.js';

export const CANARY_ASSIGNMENT_VERSION = 1;

// Replicas share this versioned key. It is not derived from a prompt or a routing key.
const ASSIGNMENT_KEY = Buffer.from('llm-proxy-canary-assignment-v1', 'utf8');

const ROUTING_KEY = /^[A-Za-z0-9._:~-]{1,200}$/;

export type CanaryCohort = 'baseline' | 'canary';

export type AssignmentInput = {
  tenantId: string;
  alias: string;
  policyVersionId: string;
  routingKey: string;
  basisPoints: number;
};

export function assignCohort(input: AssignmentInput): CanaryCohort {
  if (!Number.isInteger(input.basisPoints) || input.basisPoints <= 0) return 'baseline';
  if (input.basisPoints >= 10_000) return 'canary';
  const mac = createHmac('sha256', ASSIGNMENT_KEY)
    .update(
      [
        String(CANARY_ASSIGNMENT_VERSION),
        input.tenantId,
        input.alias,
        input.policyVersionId,
        input.routingKey,
      ].join('\n'),
      'utf8',
    )
    .digest();
  const bucket = mac.readUInt32BE(0);
  const threshold = Math.floor((input.basisPoints * 0x1_0000_0000) / 10_000);
  return bucket < threshold ? 'canary' : 'baseline';
}

export function routingKeyDigest(routingKey: string): string {
  return createHash('sha256').update(routingKey, 'utf8').digest('hex');
}

export function generatedRoutingKey(): string {
  return randomBytes(32).toString('hex');
}

export function parseRoutingKey(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value.length === 0) return null;
  if (!ROUTING_KEY.test(value)) {
    throw invalidRequest('X-LLM-Routing-Key', 'invalid_parameter', 'The routing key is invalid.');
  }
  return value;
}
