import type { RegistryProviderName } from './contract.js';

export type CostStatus = 'estimated' | 'provisional' | 'reconciled' | 'unknown';

export type StoredUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  thoughtsTokens: number | null;
};

export type PriceCandidate = {
  id: string;
  provider: string;
  model: string;
  region: string | null;
  serviceTier: string | null;
  servingProvider: string | null;
  effectiveAt: string;
  createdAt: string;
  priceSource: string;
  verificationStatus: 'verified' | 'unverified';
  currency: 'USD';
  inputRate: string | null;
  outputRate: string | null;
  cacheReadRate: string | null;
  cacheWriteRate: string | null;
  thinkingRate: string | null;
  requestFee: string | null;
  allocatedRate: string | null;
};

export type PriceQuery = {
  provider: string;
  model: string;
  location: string | null;
  serviceTier: string | null;
  servingProvider: string | null;
  at: Date;
};

export type CalculatedCost = {
  costStatus: CostStatus;
  amount: string | null;
  allocatedStatus: CostStatus | null;
  allocatedAmount: string | null;
  priceVersionId: string | null;
  currency: 'USD' | null;
};

type Count = number | 'absent' | 'invalid';
type Line = { kind: 'priced'; amount: string } | { kind: 'missing' };

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const SPLIT_PROVIDERS = new Set<RegistryProviderName>(['anthropic', 'vertex']);

export function canonicalDecimal(value: string): string {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) throw new Error('invalid decimal');
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const [wholePart = '0', fracRaw = ''] = body.split('.');
  const whole = wholePart.replace(/^0+(?=\d)/, '');
  const frac = fracRaw.replace(/0+$/, '');
  if ((whole === '0' || whole === '') && frac.length === 0) return '0';
  const text = frac.length === 0 ? whole : `${whole}.${frac}`;
  return negative ? `-${text}` : text;
}

function parts(value: string): { negative: boolean; units: bigint; scale: number } {
  const canonical = canonicalDecimal(value);
  if (canonical === '0') return { negative: false, units: 0n, scale: 0 };
  const negative = canonical.startsWith('-');
  const body = negative ? canonical.slice(1) : canonical;
  const [whole = '0', frac = ''] = body.split('.');
  return { negative, units: BigInt(`${whole}${frac}`), scale: frac.length };
}

function formatUnits(units: bigint, scale: number): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  if (absolute === 0n) return '0';
  const digits = absolute.toString();
  if (scale === 0) return negative ? `-${digits}` : digits;
  const padded = digits.padStart(scale + 1, '0');
  const whole = padded.slice(0, padded.length - scale);
  const frac = padded.slice(padded.length - scale).replace(/0+$/, '');
  const text = frac.length === 0 ? whole : `${whole}.${frac}`;
  return negative ? `-${text}` : text;
}

export function multiplyDecimal(rate: string, count: number): string {
  if (!Number.isInteger(count) || count < 0) throw new Error('invalid count');
  const part = parts(rate);
  if (part.negative) throw new Error('invalid decimal');
  return formatUnits(part.units * BigInt(count), part.scale);
}

export function maxDecimal(left: string, right: string): string {
  const first = parts(left);
  const second = parts(right);
  if (first.negative || second.negative) throw new Error('invalid decimal');
  const scale = Math.max(first.scale, second.scale);
  const scaled = (part: { units: bigint; scale: number }): bigint => part.units * 10n ** BigInt(scale - part.scale);
  return scaled(first) >= scaled(second) ? canonicalDecimal(left) : canonicalDecimal(right);
}

export function addDecimal(left: string, right: string): string {
  const first = parts(left);
  const second = parts(right);
  const scale = Math.max(first.scale, second.scale);
  const scaled = (part: { negative: boolean; units: bigint; scale: number }): bigint => {
    const magnitude = part.units * 10n ** BigInt(scale - part.scale);
    return part.negative ? -magnitude : magnitude;
  };
  return formatUnits(scaled(first) + scaled(second), scale);
}

function millis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function prefer<T>(rows: readonly T[], matches: (row: T) => boolean): T[] {
  const exact = rows.filter(matches);
  return exact.length > 0 ? exact : [...rows];
}

export function selectPrice(prices: readonly PriceCandidate[], query: PriceQuery): PriceCandidate | null {
  const at = query.at.getTime();
  let eligible = prices.filter((price) => {
    return (
      price.provider === query.provider &&
      price.model === query.model &&
      millis(price.effectiveAt) <= at &&
      (price.region === null || price.region === query.location) &&
      (price.serviceTier === null || price.serviceTier === query.serviceTier) &&
      (price.servingProvider === null || price.servingProvider === query.servingProvider)
    );
  });
  if (query.servingProvider !== null) {
    eligible = prefer(eligible, (price) => price.servingProvider === query.servingProvider);
  }
  if (query.location !== null) {
    eligible = prefer(eligible, (price) => price.region === query.location);
  }
  if (query.serviceTier !== null) {
    eligible = prefer(eligible, (price) => price.serviceTier === query.serviceTier);
  }
  if (eligible.length === 0) return null;
  eligible.sort((left, right) => {
    const byEffective = millis(right.effectiveAt) - millis(left.effectiveAt);
    if (byEffective !== 0) return byEffective;
    return millis(right.createdAt) - millis(left.createdAt);
  });
  return eligible[0] ?? null;
}

export function costToStore(existing: CalculatedCost | null, calculated: CalculatedCost): CalculatedCost {
  return existing ?? calculated;
}

function readCount(value: number | null): Count {
  if (value === null) return 'absent';
  if (!Number.isInteger(value) || value < 0) return 'invalid';
  return value;
}

function pushRate(lines: Line[], rate: string | null, count: Count, unpricedWhenPresent: boolean): void {
  if (count === 'invalid') {
    lines.push({ kind: 'missing' });
    return;
  }
  if (rate === null) {
    if (unpricedWhenPresent && count !== 'absent') lines.push({ kind: 'missing' });
    return;
  }
  if (count === 'absent') {
    lines.push({ kind: 'missing' });
    return;
  }
  lines.push({ kind: 'priced', amount: multiplyDecimal(rate, count) });
}

// A null cache or thinking count means that category was not reported.
// Bill the rate only when the count is stored. Do not invent a zero and do not mark the attempt incomplete.
function pushStoredRate(lines: Line[], rate: string | null, count: Count, unpricedWhenPresent: boolean): void {
  if (count === 'absent') return;
  pushRate(lines, rate, count, unpricedWhenPresent);
}

function openAiInputCount(usage: StoredUsage): Count {
  const prompt = readCount(usage.promptTokens);
  const stored = readCount(usage.uncachedInputTokens);
  const cacheWrite = readCount(usage.cacheCreationInputTokens);
  const cacheRead = readCount(usage.cacheReadInputTokens);
  if (stored === 'invalid' || prompt === 'invalid' || cacheWrite === 'invalid' || cacheRead === 'invalid') {
    return 'invalid';
  }
  if (typeof stored === 'number') return stored;
  const cachePresent = typeof cacheWrite === 'number' || typeof cacheRead === 'number';
  if (!cachePresent) return prompt;
  if (prompt === 'absent') return 'invalid';
  const write = typeof cacheWrite === 'number' ? cacheWrite : 0;
  const read = typeof cacheRead === 'number' ? cacheRead : 0;
  const uncached = prompt - write - read;
  if (uncached < 0) return 'invalid';
  return uncached;
}

function anyReportedUsage(usage: StoredUsage): boolean {
  return [
    usage.promptTokens,
    usage.completionTokens,
    usage.totalTokens,
    usage.uncachedInputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheReadInputTokens,
    usage.thoughtsTokens,
  ].some((value) => typeof readCount(value) === 'number');
}

function settle(
  lines: readonly Line[],
  fee: string | null,
  verified: boolean,
  anyUsage: boolean,
  anyTokenRate: boolean,
): { status: CostStatus; amount: string | null } {
  const priced = lines.filter((line): line is { kind: 'priced'; amount: string } => line.kind === 'priced');
  const missing = lines.some((line) => line.kind === 'missing');
  if (priced.length === 0) {
    if (!missing && fee !== null && !anyTokenRate && anyUsage) {
      return { status: verified ? 'estimated' : 'provisional', amount: canonicalDecimal(fee) };
    }
    return { status: 'unknown', amount: null };
  }
  let amount = priced[0]?.amount ?? '0';
  for (const line of priced.slice(1)) amount = addDecimal(amount, line.amount);
  if (fee !== null) amount = addDecimal(amount, fee);
  if (!verified || missing) return { status: 'provisional', amount };
  return { status: 'estimated', amount };
}

function externalLines(provider: RegistryProviderName, usage: StoredUsage, price: PriceCandidate): Line[] {
  const lines: Line[] = [];
  if (SPLIT_PROVIDERS.has(provider)) {
    // The stored prompt total already includes cache tokens. Bill the split counts once.
    pushRate(lines, price.inputRate, readCount(usage.uncachedInputTokens), false);
  } else {
    pushRate(lines, price.inputRate, openAiInputCount(usage), false);
  }
  pushStoredRate(lines, price.cacheWriteRate, readCount(usage.cacheCreationInputTokens), true);
  pushStoredRate(lines, price.cacheReadRate, readCount(usage.cacheReadInputTokens), true);
  pushRate(lines, price.outputRate, readCount(usage.completionTokens), false);
  pushStoredRate(lines, price.thinkingRate, readCount(usage.thoughtsTokens), false);
  return lines;
}

function allocatedLines(usage: StoredUsage, rate: string): Line[] {
  const lines: Line[] = [];
  // total_tokens is not the billable sum. A DGX total can differ from prompt plus completion.
  pushRate(lines, rate, readCount(usage.promptTokens), false);
  pushRate(lines, rate, readCount(usage.completionTokens), false);
  return lines;
}

export function calculateCost(input: {
  provider: RegistryProviderName;
  usage: StoredUsage;
  price: PriceCandidate | null;
}): CalculatedCost {
  if (input.price === null) {
    return {
      costStatus: 'unknown',
      amount: null,
      allocatedStatus: input.provider === 'dgx' ? 'unknown' : null,
      allocatedAmount: null,
      priceVersionId: null,
      currency: null,
    };
  }
  const verified = input.price.verificationStatus === 'verified';
  const anyUsage = anyReportedUsage(input.usage);
  const anyTokenRate = [
    input.price.inputRate,
    input.price.outputRate,
    input.price.cacheReadRate,
    input.price.cacheWriteRate,
    input.price.thinkingRate,
  ].some((rate) => rate !== null);
  const external = settle(
    externalLines(input.provider, input.usage, input.price),
    input.price.requestFee,
    verified,
    anyUsage,
    anyTokenRate,
  );
  let allocatedStatus: CostStatus | null = null;
  let allocatedAmount: string | null = null;
  if (input.provider === 'dgx') {
    if (input.price.allocatedRate === null) {
      allocatedStatus = 'unknown';
      allocatedAmount = null;
    } else {
      const allocated = settle(allocatedLines(input.usage, input.price.allocatedRate), null, verified, anyUsage, true);
      allocatedStatus = allocated.status;
      allocatedAmount = allocated.amount;
    }
  }
  return {
    costStatus: external.status,
    amount: external.amount,
    allocatedStatus,
    allocatedAmount,
    priceVersionId: input.price.id,
    currency: 'USD',
  };
}
