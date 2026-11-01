import { createHash } from 'node:crypto';
import { COUNTER_TTL_SECONDS, type RedisCommandClient } from './hot-counters.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RATE_SCOPES = ['api_key_requests', 'tenant_requests', 'api_key_tokens', 'tenant_tokens'] as const;
export type RateScope = (typeof RATE_SCOPES)[number];

// Spend only a slice that PostgreSQL already charged. A missing field is not a fresh grant.
export const ACTIVE_SPEND_SCRIPT = `
local tenant = ARGV[1]
local attempt = ARGV[2]
local ttl = tonumber(ARGV[3])
local count = tonumber(ARGV[4])
if count == nil or count ~= #KEYS or count < 1 or ttl == nil or ttl < 1 then
  return {"ok","deny","0","0","bad_request"}
end
for i = 1, #KEYS do
  local tag = string.match(KEYS[i], "^rl:{([^}]+)}")
  if tag ~= tenant then
    return {"ok","deny","0","0","wrong_tenant"}
  end
end
local seen = "s:" .. attempt
local prior = nil
for i = 1, #KEYS do
  local prev = redis.call("HGET", KEYS[i], seen)
  if prev == false or prev == nil then
    if prior ~= nil then
      return {"ok","missing","0","0","split"}
    end
  else
    if prior == nil then
      prior = prev
    elseif prior ~= prev then
      return {"ok","missing","0","0","split"}
    end
  end
end
if prior ~= nil then
  local decision, remaining = string.match(prior, "^(%a+):(%d+)$")
  if decision ~= "allow" and decision ~= "deny" then
    return {"ok","missing","0","0","invalid"}
  end
  return {"ok", decision, remaining, "1", "duplicate"}
end
local levels = {}
local tight = nil
for i = 1, #KEYS do
  local cost = tonumber(ARGV[4 + i])
  local raw = redis.call("HGET", KEYS[i], "n")
  if raw == false or raw == nil then
    return {"ok","missing","0","0","missing"}
  end
  local level = tonumber(raw)
  if level == nil or cost == nil or cost < 1 then
    return {"ok","deny","0","0","bad_request"}
  end
  if level < cost then
    for j = 1, #KEYS do
      redis.call("HSET", KEYS[j], seen, "deny:" .. tostring(math.floor(level)))
      redis.call("EXPIRE", KEYS[j], ttl)
    end
    return {"ok","deny", tostring(math.floor(level)), "0", "empty"}
  end
  levels[i] = level - cost
  if tight == nil or levels[i] < tight then
    tight = levels[i]
  end
end
for i = 1, #KEYS do
  redis.call("HSET", KEYS[i], "n", tostring(math.floor(levels[i])))
  redis.call("HSET", KEYS[i], seen, "allow:" .. tostring(math.floor(tight)))
  redis.call("EXPIRE", KEYS[i], ttl)
end
return {"ok","allow", tostring(math.floor(tight)), "0", "ok"}
`;

export const ACTIVE_SEED_SCRIPT = `
local tenant = ARGV[1]
local amount = ARGV[2]
local ttl = tonumber(ARGV[3])
local tag = string.match(KEYS[1], "^rl:{([^}]+)}")
if tag ~= tenant or ttl == nil or ttl < 1 or string.match(amount, "^[1-9][0-9]*$") == nil then
  return {"ok","deny","bad_request"}
end
local created = redis.call("HSETNX", KEYS[1], "n", amount)
redis.call("EXPIRE", KEYS[1], ttl)
if created == 1 then
  return {"ok","seeded", amount}
end
local current = redis.call("HGET", KEYS[1], "n")
if current == false or current == nil then
  return {"ok","mismatch", ""}
end
-- A lower level is a spend by another replica, not a second grant.
if string.match(current, "^[0-9]+$") ~= nil and not (tonumber(current) > tonumber(amount)) then
  return {"ok","same", current}
end
return {"ok","mismatch", tostring(current)}
`;

export type QuotaSlice = {
  tenantId: string;
  scope: RateScope;
  scopeId: string;
  windowMs: number;
  epoch: number;
  generation: number;
  revision: string;
  amount: number;
  cost: number;
  version: number;
  needsSeed: boolean;
};

export type ActiveSpendResult = {
  decision: 'allow' | 'deny' | 'missing' | 'unknown';
  reason: string;
  remaining: number;
  durationMs: number;
};

export type ActiveSeedResult = {
  ok: boolean;
  reason: string;
  durationMs: number;
};

let spendSha: string | null = null;
let seedSha: string | null = null;

export async function loadActiveScripts(client: RedisCommandClient): Promise<boolean> {
  try {
    const spend = text(await client.sendCommand(['SCRIPT', 'LOAD', ACTIVE_SPEND_SCRIPT])).trim();
    const seed = text(await client.sendCommand(['SCRIPT', 'LOAD', ACTIVE_SEED_SCRIPT])).trim();
    if (!/^[0-9a-f]{40}$/.test(spend) || !/^[0-9a-f]{40}$/.test(seed)) return false;
    spendSha = spend;
    seedSha = seed;
    return true;
  } catch {
    return false;
  }
}

export function quotaKey(slice: Pick<QuotaSlice, 'tenantId' | 'scope' | 'scopeId' | 'windowMs' | 'epoch' | 'generation' | 'revision'>): string {
  const tenantId = slice.tenantId.toLowerCase();
  const scopeId = slice.scopeId.toLowerCase();
  return `rl:{${tenantId}}:q:${slice.scope}:${scopeId}:w${slice.windowMs}:e${slice.epoch}:g${slice.generation}:v${slice.revision}`;
}

export function rateReason(scope: RateScope): string {
  if (scope === 'tenant_requests') return 'tenant_rate_limited';
  if (scope === 'api_key_requests') return 'api_key_rate_limited';
  if (scope === 'tenant_tokens') return 'token_rate_limited';
  return 'api_key_token_limited';
}

export async function seedQuotaSlices(
  client: RedisCommandClient,
  slices: readonly QuotaSlice[],
  timeoutMs: number,
): Promise<ActiveSeedResult> {
  const started = Date.now();
  try {
    for (const slice of slices) {
      const key = quotaKey(slice);
      const reply = await raceTimeout(
        runScript(client, ACTIVE_SEED_SCRIPT, () => seedSha, (sha) => {
          seedSha = sha;
        }, [key], [slice.tenantId.toLowerCase(), String(slice.amount), String(COUNTER_TTL_SECONDS)]),
        timeoutMs,
      );
      const parsed = parseShort(reply);
      if (parsed === null || (parsed.kind !== 'seeded' && parsed.kind !== 'same')) {
        return { ok: false, reason: parsed?.kind ?? 'invalid', durationMs: Date.now() - started };
      }
    }
    return { ok: true, reason: 'seeded', durationMs: Date.now() - started };
  } catch {
    return { ok: false, reason: 'unknown', durationMs: Date.now() - started };
  }
}

export async function spendQuotaSlices(
  client: RedisCommandClient,
  slices: readonly QuotaSlice[],
  attemptId: string,
  timeoutMs: number,
): Promise<ActiveSpendResult> {
  const started = Date.now();
  const finish = (decision: ActiveSpendResult['decision'], reason: string, remaining = 0): ActiveSpendResult => ({
    decision,
    reason,
    remaining,
    durationMs: Date.now() - started,
  });
  if (slices.length === 0 || slices.length > 4) return finish('unknown', 'bad_request');
  const tenantId = slices[0]?.tenantId.toLowerCase() ?? '';
  const attempt = attemptId.toLowerCase();
  if (!UUID.test(tenantId) || !UUID.test(attempt)) return finish('unknown', 'bad_request');
  if (slices.some((slice) => slice.tenantId.toLowerCase() !== tenantId)) return finish('unknown', 'bad_request');
  const keys = slices.map((slice) => quotaKey(slice));
  try {
    const reply = await raceTimeout(
      runScript(client, ACTIVE_SPEND_SCRIPT, () => spendSha, (sha) => {
        spendSha = sha;
      }, keys, [tenantId, attempt, String(COUNTER_TTL_SECONDS), String(slices.length), ...slices.map((slice) => String(slice.cost))]),
      timeoutMs,
    );
    const parsed = parseSpend(reply);
    if (parsed === null) return finish('unknown', 'invalid');
    if (parsed.decision === 'missing') return finish('missing', parsed.reason, parsed.remaining);
    return finish(parsed.decision, parsed.reason, parsed.remaining);
  } catch {
    return finish('unknown', 'unknown');
  }
}

export async function readQuotaLevel(
  client: RedisCommandClient,
  slice: QuotaSlice,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const reply = await raceTimeout(client.sendCommand(['HGET', quotaKey(slice), 'n']), timeoutMs);
    if (reply === null || reply === undefined) return null;
    const textValue = text(reply);
    if (!/^\d+$/.test(textValue)) return null;
    return Number(textValue);
  } catch {
    return null;
  }
}

async function runScript(
  client: RedisCommandClient,
  script: string,
  current: () => string | null,
  store: (sha: string) => void,
  keys: string[],
  args: string[],
): Promise<unknown> {
  const sha = current() ?? sha1(script);
  try {
    return await client.sendCommand(['EVALSHA', sha, String(keys.length), ...keys, ...args]);
  } catch (error) {
    if (!isNoScript(error)) throw error;
    const loaded = text(await client.sendCommand(['SCRIPT', 'LOAD', script])).trim();
    if (!/^[0-9a-f]{40}$/.test(loaded)) throw new Error('script load failed');
    store(loaded);
    return client.sendCommand(['EVALSHA', loaded, String(keys.length), ...keys, ...args]);
  }
}

function parseSpend(reply: unknown): { decision: 'allow' | 'deny' | 'missing'; reason: string; remaining: number } | null {
  if (!Array.isArray(reply) || reply.length !== 5) return null;
  if (text(reply[0]) !== 'ok') return null;
  const decision = text(reply[1]);
  const remaining = text(reply[2]);
  const duplicate = text(reply[3]);
  const reason = text(reply[4]);
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'missing') return null;
  if (!/^\d+$/.test(remaining)) return null;
  if (duplicate !== '0' && duplicate !== '1') return null;
  if (!/^[a-z_]{1,32}$/.test(reason)) return null;
  return { decision, reason, remaining: Number(remaining) };
}

function parseShort(reply: unknown): { kind: string } | null {
  if (!Array.isArray(reply) || reply.length !== 3) return null;
  if (text(reply[0]) !== 'ok') return null;
  const kind = text(reply[1]);
  if (!/^[a-z_]{1,32}$/.test(kind)) return null;
  return { kind };
}

function isNoScript(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('NOSCRIPT');
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

function sha1(script: string): string {
  return createHash('sha1').update(script).digest('hex');
}

function raceTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    timer.unref();
  });
  work.then(
    () => undefined,
    () => undefined,
  );
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
