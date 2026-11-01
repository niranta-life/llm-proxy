export type PerfModel = 'openai' | 'anthropic' | 'xai';
export type ReserveModel = PerfModel | 'auto';

export const RATES: Record<PerfModel, { input: number; output: number }> = {
  openai: { input: 0.00000015, output: 0.0000006 },
  anthropic: { input: 0.000003, output: 0.000015 },
  xai: { input: 0.000002, output: 0.000006 },
};

export const JUDGE_OUTPUT_TOKENS = 256;

export const RESERVE = {
  xai: 0.009528,
  anthropic: 0.000408,
  openai: 0.00002,
  // 2000 prompt tokens plus the judge output cap, at the OpenAI rates.
  judge: 2000 * RATES.openai.input + JUDGE_OUTPUT_TOKENS * RATES.openai.output,
} as const;

export type CeilingSet = {
  openai: number;
  anthropic: number;
  xai: number;
  judgePairs: number;
};

export function smokeCeilings(): CeilingSet {
  return { openai: 8, anthropic: 8, xai: 3, judgePairs: 1 };
}

export function scaleCeilings(): CeilingSet {
  return { openai: 500, anthropic: 500, xai: 50, judgePairs: 6 };
}

export const DEFAULT_CAPS = {
  smoke: 0.25,
  scale: 1.0,
} as const;

export function rejectMaxUsd(value: number, acceptFlag: boolean): boolean {
  if (!Number.isFinite(value)) return true;
  if (value > 2 && !acceptFlag) return true;
  return false;
}

export function nearestRank(sortedAsc: readonly number[], percentile: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const index = Math.ceil((percentile / 100) * n) - 1;
  const clamped = Math.max(0, Math.min(n - 1, index));
  return sortedAsc[clamped] ?? null;
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function deriveThoughts(
  prompt: number | null | undefined,
  completion: number | null | undefined,
  total: number | null | undefined,
  thoughts: number | null | undefined,
): number | null {
  if (isNonNegInt(thoughts)) return thoughts;
  if (!isNonNegInt(prompt) || !isNonNegInt(completion) || !isNonNegInt(total)) return null;
  const gap = total - prompt - completion;
  if (gap === 0) return null;
  return Math.max(0, gap);
}

export function estimateUsd(
  model: PerfModel | 'judge',
  prompt: number | null | undefined,
  completion: number | null | undefined,
  total: number | null | undefined,
  thoughts: number | null | undefined,
): number | null {
  if (!isNonNegInt(prompt) || !isNonNegInt(completion) || !isNonNegInt(total)) return null;
  const rates = model === 'judge' ? RATES.openai : RATES[model];
  const derived = deriveThoughts(prompt, completion, total, thoughts);
  const thoughtCount = derived === null ? 0 : derived;
  return prompt * rates.input + (completion + thoughtCount) * rates.output;
}

export function reserveFor(model: ReserveModel | 'judge'): number {
  if (model === 'judge') return RESERVE.judge;
  // The alias can land on any enabled deployment. Hold the largest reserve until that name is known.
  if (model === 'auto') return Math.max(RESERVE.openai, RESERVE.anthropic, RESERVE.xai);
  return RESERVE[model];
}

export function priceCall(
  model: ReserveModel | 'judge',
  deployment: string | null,
  prompt: number | null | undefined,
  completion: number | null | undefined,
  total: number | null | undefined,
  thoughts: number | null | undefined,
): number | null {
  if (model === 'judge') return estimateUsd('judge', prompt, completion, total, thoughts);
  const bill: PerfModel | null =
    model === 'auto'
      ? deployment === 'openai' || deployment === 'anthropic' || deployment === 'xai'
        ? deployment
        : null
      : model;
  if (bill === null) return null;
  return estimateUsd(bill, prompt, completion, total, thoughts);
}

export type StopReason = 'cap' | 'ceiling';

export class SpendLedger {
  readonly cap: number;
  spent = 0;
  reserved = 0;
  readonly counts: Record<PerfModel, number> = { openai: 0, anthropic: 0, xai: 0 };
  judgeCalls = 0;
  private readonly ceilings: { openai: number; anthropic: number; xai: number; judgeCalls: number };

  constructor(cap: number, ceilings: CeilingSet) {
    this.cap = cap;
    this.ceilings = {
      openai: ceilings.openai,
      anthropic: ceilings.anthropic,
      xai: ceilings.xai,
      judgeCalls: ceilings.judgePairs * 2,
    };
  }

  inspectReserve(model: ReserveModel, reserve: number, asJudge = false): 'ok' | StopReason {
    const key: PerfModel = model === 'auto' ? 'openai' : model;
    if (this.spent + this.reserved + reserve > this.cap) return 'cap';
    if (this.counts[key] >= this.ceilings[key]) return 'ceiling';
    if (asJudge && this.judgeCalls >= this.ceilings.judgeCalls) return 'ceiling';
    return 'ok';
  }

  tryReserve(model: ReserveModel, reserve: number, asJudge = false): boolean {
    const key: PerfModel = model === 'auto' ? 'openai' : model;
    if (this.inspectReserve(model, reserve, asJudge) !== 'ok') return false;
    this.reserved += reserve;
    this.counts[key] += 1;
    if (asJudge) this.judgeCalls += 1;
    return true;
  }

  settle(reserve: number, amount: number | null): void {
    this.reserved -= reserve;
    this.spent += amount === null ? reserve : amount;
  }
}
