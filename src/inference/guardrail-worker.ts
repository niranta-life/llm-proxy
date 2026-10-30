import type { Pool } from 'pg';
import { performance } from 'node:perf_hooks';
import { withTenant } from '../db/tenant-context.js';
import { ProxyError } from './errors.js';
import { decideGuardrails, type GuardrailDecision, type GuardrailRule } from './guardrail-decision.js';
import { listActiveGuardrails, loadCohortMetrics, rollbackRollout } from './guardrail-store.js';

export type GuardrailPassReport = {
  detectionMs: number;
  rollbackMs: number;
  monitorMs: number;
  monitorRows: number;
  heapUsed: number;
  stops: number;
  readFailures: number;
};

type WindowGroup = {
  windowSeconds: number;
  maturitySeconds: number;
  rules: GuardrailRule[];
};

export async function runGuardrailPass(pool: Pool, tenantIds: readonly string[]): Promise<GuardrailPassReport> {
  const passStarted = performance.now();
  let detectionMs = 0;
  let rollbackMs = 0;
  let monitorMs = 0;
  let monitorRows = 0;
  let stops = 0;
  let readFailures = 0;

  for (const tenantId of tenantIds) {
    let active;
    try {
      active = await withTenant(pool, tenantId, (client) => listActiveGuardrails(client));
    } catch {
      readFailures += 1;
      continue;
    }
    for (const guard of active) {
      const groups = new Map<string, WindowGroup>();
      for (const rule of guard.rules) {
        const key = `${rule.windowSeconds}:${rule.maturitySeconds}`;
        const group = groups.get(key) ?? {
          windowSeconds: rule.windowSeconds,
          maturitySeconds: rule.maturitySeconds,
          rules: [],
        };
        group.rules.push(rule);
        groups.set(key, group);
      }
      let decision: GuardrailDecision | null = null;
      let failedRead = false;
      const monitorStarted = performance.now();
      for (const group of groups.values()) {
        try {
          const loaded = await withTenant(pool, tenantId, (client) =>
            loadCohortMetrics(client, guard.rolloutId, group.windowSeconds, group.maturitySeconds),
          );
          monitorRows += loaded.monitorRows;
          const next = decideGuardrails(group.rules, loaded.snapshot);
          decision = next;
          if (next.action === 'stop') break;
        } catch {
          failedRead = true;
          break;
        }
      }
      monitorMs += performance.now() - monitorStarted;
      if (failedRead || decision === null || decision.action !== 'stop') {
        if (failedRead) readFailures += 1;
        continue;
      }
      const stopping = decision;
      const rollbackStarted = performance.now();
      try {
        await withTenant(pool, tenantId, (client) =>
          rollbackRollout(
            client,
            tenantId,
            guard.rolloutId,
            `guardrail:${guard.rolloutId}:${guard.epoch}`,
            guard.epoch,
            'guardrail',
            {
              ruleId: stopping.ruleId,
              kind: stopping.kind,
              signal: stopping.signal,
              reason: stopping.reason,
              evidence: stopping.detail,
            },
          ),
        );
        stops += 1;
        rollbackMs += performance.now() - rollbackStarted;
        if (detectionMs === 0) detectionMs = performance.now() - passStarted;
      } catch (error) {
        const code = error instanceof ProxyError ? error.code : null;
        if (code === 'stale_activation' || code === 'idempotency_conflict') continue;
        readFailures += 1;
      }
    }
  }

  return {
    detectionMs,
    rollbackMs,
    monitorMs,
    monitorRows,
    heapUsed: process.memoryUsage().heapUsed,
    stops,
    readFailures,
  };
}
