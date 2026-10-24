export const SAMPLE_MODES = ['disabled', 'metadata_only', 'encrypted_sample'] as const;
export const DATA_CLASSES = ['public', 'internal', 'confidential', 'restricted'] as const;
export const SAMPLE_PROVIDERS = ['openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx'] as const;

export type SampleMode = (typeof SAMPLE_MODES)[number];
export type DataClass = (typeof DATA_CLASSES)[number];

export type SamplePolicy = {
  mode: SampleMode;
  contentCapture: boolean;
  replay: boolean;
  judgeDisclosure: boolean;
  sampleRate: number;
  maxSampleBytes: number;
  maxSampleCount: number;
  retentionSeconds: number;
  approvedClassifications: readonly string[];
  allowedProviders: readonly string[];
  allowedDeployments: readonly string[];
};

export type CaptureFacts = {
  dataClass: string | null;
  provider: string;
  deployment: string;
  sampleBytes: number;
  storedCount: number;
  draw: number;
  ageMs: number;
};

export type CaptureReason =
  | 'selected'
  | 'disabled'
  | 'metadata_only'
  | 'missing_permission'
  | 'data_class'
  | 'provider'
  | 'deployment'
  | 'size'
  | 'count'
  | 'retention_elapsed'
  | 'rate';

export type CaptureDecision = {
  capture: boolean;
  reason: CaptureReason;
  replay: boolean;
  judgeDisclosure: boolean;
};

const RATE_SCALE = 1_000_000;

export function defaultSamplePolicy(): SamplePolicy {
  return {
    mode: 'metadata_only',
    contentCapture: false,
    replay: false,
    judgeDisclosure: false,
    sampleRate: 0,
    maxSampleBytes: 0,
    maxSampleCount: 0,
    retentionSeconds: 0,
    approvedClassifications: [],
    allowedProviders: [],
    allowedDeployments: [],
  };
}

export function isSampleMode(value: string): value is SampleMode {
  return (SAMPLE_MODES as readonly string[]).includes(value);
}

export function isDataClass(value: string): value is DataClass {
  return (DATA_CLASSES as readonly string[]).includes(value);
}

function denied(policy: SamplePolicy | null, reason: CaptureReason): CaptureDecision {
  return {
    capture: false,
    reason,
    replay: policy?.replay ?? false,
    judgeDisclosure: policy?.judgeDisclosure ?? false,
  };
}

function rateUnits(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * RATE_SCALE);
}

export function decideSampleCapture(policy: SamplePolicy | null, facts: CaptureFacts): CaptureDecision {
  const active = policy ?? defaultSamplePolicy();
  if (active.mode === 'disabled') return denied(active, 'disabled');
  if (active.mode !== 'encrypted_sample') return denied(active, 'metadata_only');
  if (!active.contentCapture) return denied(active, 'missing_permission');
  if (facts.dataClass === null || !active.approvedClassifications.includes(facts.dataClass)) {
    return denied(active, 'data_class');
  }
  if (!active.allowedProviders.includes(facts.provider)) return denied(active, 'provider');
  if (!active.allowedDeployments.includes(facts.deployment)) return denied(active, 'deployment');
  if (!Number.isFinite(facts.sampleBytes) || facts.sampleBytes > active.maxSampleBytes) return denied(active, 'size');
  if (!Number.isFinite(facts.storedCount) || facts.storedCount >= active.maxSampleCount) return denied(active, 'count');
  if (!Number.isFinite(active.retentionSeconds) || active.retentionSeconds <= 0) return denied(active, 'retention_elapsed');
  if (!Number.isFinite(facts.ageMs) || facts.ageMs >= active.retentionSeconds * 1000) {
    return denied(active, 'retention_elapsed');
  }
  const rate = rateUnits(active.sampleRate);
  const draw = rateUnits(facts.draw);
  if (rate === null || draw === null || draw < 0 || draw > RATE_SCALE) return denied(active, 'rate');
  if (rate <= 0) return denied(active, 'rate');
  if (rate < RATE_SCALE && draw >= rate) return denied(active, 'rate');
  return {
    capture: true,
    reason: 'selected',
    replay: active.replay,
    judgeDisclosure: active.judgeDisclosure,
  };
}
