import type { PoolClient } from 'pg';
import { admitAttempt, type AdmitDecision } from '../db/admission.js';

export type RateLimitAdmitInput = Parameters<typeof admitAttempt>[1];

export interface RateLimitStore {
  admit(client: PoolClient, input: RateLimitAdmitInput): Promise<AdmitDecision>;
}

export class PostgresRateLimitStore implements RateLimitStore {
  async admit(client: PoolClient, input: RateLimitAdmitInput): Promise<AdmitDecision> {
    return admitAttempt(client, input);
  }
}

export function createRateLimitStore(): RateLimitStore {
  return new PostgresRateLimitStore();
}
