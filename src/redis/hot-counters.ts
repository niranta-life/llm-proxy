import { createHash } from 'node:crypto';

export const COUNTER_SCALE = 1000;
export const COUNTER_TTL_SECONDS = 180;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UNITS = 1_000_000_000;

export const TOKEN_BUCKET_SCRIPT = `-- Token bucket for one tenant. One key keeps one Redis Cluster slot.
-- Redis TIME is the only clock. Amounts are milli-tokens.
local SCALE = ${COUNTER_SCALE}
local MAX_FIELDS = 2048

local key = KEYS[1]
local tenant = ARGV[1]
local attempt = ARGV[2]
local ttl = tonumber(ARGV[3])
local count = tonumber(ARGV[4])

local tag = string.match(key, "^rl:{([^}]+)}:v[0-9a-f]+$")
if tag == nil or tag ~= tenant then
  return {"ok", "deny", "0", "0", "wrong_tenant"}
end
if ttl == nil or ttl < 1 or ttl > 600 then
  return {"ok", "deny", "0", "0", "bad_request"}
end
if attempt == nil or string.match(attempt, "^[0-9a-f%-]+$") == nil or #attempt < 32 or #attempt > 64 then
  return {"ok", "deny", "0", "0", "bad_request"}
end
if count == nil or count < 1 or count > 4 then
  return {"ok", "deny", "0", "0", "bad_request"}
end

local seen = "s:" .. attempt
local previous = redis.call("HGET", key, seen)
if previous ~= false and previous ~= nil then
  local decision, remaining = string.match(tostring(previous), "^(allow):([0-9]+)$")
  if decision == nil then
    decision, remaining = string.match(tostring(previous), "^(deny):([0-9]+)$")
  end
  if (decision == "allow" or decision == "deny") and remaining ~= nil then
    redis.call("EXPIRE", key, ttl)
    return {"ok", decision, remaining, "1", "duplicate"}
  end
end

local names = {}
local capacities = {}
local costs = {}
local arg = 5
for i = 1, count do
  local name = ARGV[arg]
  local capacity = tonumber(ARGV[arg + 1])
  local cost = tonumber(ARGV[arg + 2])
  arg = arg + 3
  if name == nil or string.match(name, "^[a-z0-9:_-]+$") == nil or #name > 80 then
    return {"ok", "deny", "0", "0", "bad_request"}
  end
  if capacity == nil or capacity < 1 or capacity > 1000000000 or math.floor(capacity) ~= capacity then
    return {"ok", "deny", "0", "0", "bad_request"}
  end
  if cost == nil or cost < 1 or cost > 1000000000 or math.floor(cost) ~= cost then
    return {"ok", "deny", "0", "0", "bad_request"}
  end
  names[i] = name
  capacities[i] = capacity
  costs[i] = cost
end

local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000000 + tonumber(time[2])
local levels = {}
local residuals = {}
local allow = true
for i = 1, count do
  local capacity = capacities[i]
  local cost = costs[i]
  local raw = redis.call("HGET", key, "t:" .. names[i])
  local stamp = redis.call("HGET", key, "m:" .. names[i])
  local tokens = capacity * SCALE
  local residual = 0
  if raw ~= false and raw ~= nil and stamp ~= false and stamp ~= nil then
    tokens = tonumber(raw)
    local then_us = tonumber(stamp)
    if tokens == nil or then_us == nil then
      tokens = capacity * SCALE
    else
      local elapsed = now - then_us
      if elapsed < 0 then elapsed = 0 end
      if elapsed > 3600000000 then elapsed = 3600000000 end
      -- Sub-quantum credit stays in r:. Moving the stamp alone drops it.
      local carried = tonumber(redis.call("HGET", key, "r:" .. names[i]))
      if carried == nil or carried < 0 or carried >= 60000 then carried = 0 end
      local whole = math.floor(elapsed / 60000) * capacity
      local frac_num = (elapsed % 60000) * capacity + carried
      local frac = math.floor(frac_num / 60000)
      residual = frac_num % 60000
      tokens = tokens + whole + frac
      local full = capacity * SCALE
      if tokens >= full then
        tokens = full
        residual = 0
      end
      if tokens < 0 then tokens = 0 end
    end
  end
  levels[i] = tokens
  residuals[i] = residual
  if tokens < cost * SCALE then allow = false end
end

local decision = "deny"
if allow then decision = "allow" end
local tight = nil
for i = 1, count do
  local stored = levels[i]
  if allow then stored = levels[i] - costs[i] * SCALE end
  if tight == nil or stored < tight then tight = stored end
  redis.call("HSET", key, "t:" .. names[i], tostring(math.floor(stored)))
  redis.call("HSET", key, "m:" .. names[i], tostring(math.floor(now)))
  redis.call("HSET", key, "r:" .. names[i], tostring(math.floor(residuals[i])))
end
if redis.call("HLEN", key) >= MAX_FIELDS then
  local all = redis.call("HGETALL", key)
  local removed = 0
  for i = 1, #all, 2 do
    local field = all[i]
    if string.sub(field, 1, 2) == "s:" and field ~= seen then
      redis.call("HDEL", key, field)
      removed = removed + 1
      if removed >= 32 then break end
    end
  end
end
if redis.call("HLEN", key) < MAX_FIELDS then
  redis.call("HSET", key, seen, decision .. ":" .. tostring(math.floor(tight)))
end
redis.call("EXPIRE", key, ttl)
return {"ok", decision, tostring(math.floor(tight)), "0", "ok"}
`;

export type RateLimitSnapshot = {
  tenantMode: string | null;
  tenantRequestsPerMinute: number | null;
  tenantTokensPerMinute: number | null;
  apiKeyMode: string | null;
  apiKeyRequestsPerMinute: number | null;
  apiKeyTokensPerMinute: number | null;
};

export type RateShadowInput = {
  tenantId: string;
  apiKeyId: string;
  attemptId: string;
  tokenCost: number | null;
  postgresDecision: 'allow' | 'deny';
  limits: RateLimitSnapshot;
};

export type HotCounterInput = {
  tenantId: string;
  apiKeyId: string;
  attemptId: string;
  tokenCost: number | null;
  limits: RateLimitSnapshot;
  presentedKey?: string;
};

export type HotCounterResult = {
  decision: 'allow' | 'deny' | 'unknown';
  remaining: number;
  duplicate: boolean;
  reason: string;
  reloaded: boolean;
  durationMs: number;
};

export type RedisCommandClient = {
  sendCommand(args: string[]): Promise<unknown>;
};

type Bucket = { name: string; capacity: number; cost: number };

let loadedSha: string | null = null;

export function policyRevision(limits: RateLimitSnapshot): string {
  // API-key limits are fields in this key. A key policy must not open a second tenant bucket.
  const parts = [
    limits.tenantMode ?? '',
    limits.tenantRequestsPerMinute ?? '',
    limits.tenantTokensPerMinute ?? '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export function counterKey(tenantId: string, revision: string): string {
  return `rl:{${tenantId.toLowerCase()}}:v${revision}`;
}

export async function loadTokenBucketScript(client: RedisCommandClient): Promise<boolean> {
  try {
    const loaded = text(await client.sendCommand(['SCRIPT', 'LOAD', TOKEN_BUCKET_SCRIPT])).trim();
    if (!/^[0-9a-f]{40}$/.test(loaded)) return false;
    loadedSha = loaded;
    return true;
  } catch {
    return false;
  }
}

export async function checkHotCounters(
  client: RedisCommandClient,
  input: HotCounterInput,
  timeoutMs: number,
): Promise<HotCounterResult> {
  const started = Date.now();
  const finish = (result: Omit<HotCounterResult, 'durationMs'>): HotCounterResult => ({
    ...result,
    durationMs: Date.now() - started,
  });
  const tenantId = input.tenantId.toLowerCase();
  const apiKeyId = input.apiKeyId.toLowerCase();
  const attemptId = input.attemptId.toLowerCase();
  if (!UUID.test(tenantId) || !UUID.test(apiKeyId) || !UUID.test(attemptId)) {
    return finish(unknown('bad_request'));
  }
  const buckets = rateBuckets({ ...input, tenantId, apiKeyId, attemptId });
  if (buckets === null) return finish(unknown('bad_request'));
  if (buckets.length === 0) {
    return finish({ decision: 'allow', remaining: 0, duplicate: false, reason: 'no_limit', reloaded: false });
  }
  const revision = policyRevision(input.limits);
  let key = counterKey(tenantId, revision);
  if (input.presentedKey !== undefined) {
    if (input.presentedKey.length === 0 || input.presentedKey.length > 256 || /[\s\u0000]/.test(input.presentedKey)) {
      return finish(unknown('bad_request'));
    }
    key = input.presentedKey;
  }
  const args = [
    tenantId,
    attemptId,
    String(COUNTER_TTL_SECONDS),
    String(buckets.length),
    ...buckets.flatMap((bucket) => [bucket.name, String(bucket.capacity), String(bucket.cost)]),
  ];
  let reloaded = false;
  try {
    const reply = await raceTimeout(runScript(client, key, args, () => {
      reloaded = true;
    }), timeoutMs);
    const parsed = parseReply(reply);
    if (parsed === null) return finish({ ...unknown('invalid'), reloaded });
    if (parsed.reason === 'bad_request') return finish({ ...unknown('bad_request'), reloaded });
    return finish({ ...parsed, reloaded });
  } catch {
    return finish(unknown('unknown'));
  }
}

function unknown(reason: string): Omit<HotCounterResult, 'durationMs'> {
  return { decision: 'unknown', remaining: 0, duplicate: false, reason, reloaded: false };
}

function rateBuckets(input: HotCounterInput): Bucket[] | null {
  const buckets: Bucket[] = [];
  const push = (name: string, capacity: number | null, cost: number): boolean => {
    if (capacity === null) return true;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_UNITS) return false;
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > MAX_UNITS) return false;
    buckets.push({ name, capacity, cost });
    return true;
  };
  if (!push('tr', input.limits.tenantRequestsPerMinute, 1)) return null;
  if (!push(`kr:${input.apiKeyId}`, input.limits.apiKeyRequestsPerMinute, 1)) return null;
  const tokenCost = input.tokenCost;
  if (tokenCost !== null && tokenCost > 0) {
    if (!push('tt', input.limits.tenantTokensPerMinute, tokenCost)) return null;
    if (!push(`kt:${input.apiKeyId}`, input.limits.apiKeyTokensPerMinute, tokenCost)) return null;
  }
  return buckets;
}

async function runScript(
  client: RedisCommandClient,
  key: string,
  args: string[],
  onReload: () => void,
): Promise<unknown> {
  const sha = loadedSha ?? sha1(TOKEN_BUCKET_SCRIPT);
  try {
    return await client.sendCommand(['EVALSHA', sha, '1', key, ...args]);
  } catch (error) {
    if (!isNoScript(error)) throw error;
    onReload();
    const loaded = text(await client.sendCommand(['SCRIPT', 'LOAD', TOKEN_BUCKET_SCRIPT])).trim();
    if (!/^[0-9a-f]{40}$/.test(loaded)) throw new Error('script load failed');
    loadedSha = loaded;
    return client.sendCommand(['EVALSHA', loaded, '1', key, ...args]);
  }
}

function parseReply(reply: unknown): Omit<HotCounterResult, 'durationMs' | 'reloaded'> | null {
  if (!Array.isArray(reply) || reply.length !== 5) return null;
  const marker = text(reply[0]);
  const decision = text(reply[1]);
  const remaining = text(reply[2]);
  const duplicate = text(reply[3]);
  const reason = text(reply[4]);
  if (marker !== 'ok') return null;
  if (decision !== 'allow' && decision !== 'deny') return null;
  if (!/^\d+$/.test(remaining)) return null;
  if (duplicate !== '0' && duplicate !== '1') return null;
  if (!/^[a-z_]{1,32}$/.test(reason)) return null;
  return {
    decision,
    remaining: Number(remaining),
    duplicate: duplicate === '1',
    reason,
  };
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
