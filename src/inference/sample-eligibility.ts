import type { PoolClient } from 'pg';
import { invalidRequest } from './errors.js';

export const ELIGIBILITY_CHECKS = [
  'sample_completeness',
  'content_availability',
  'capture_authorization',
  'replay_authorization',
  'expiry_revocation',
  'target_deployment_permission',
  'target_model_capabilities',
  'provider_location',
  'tool_or_multimodal',
] as const;

export type EligibilityCheckName = (typeof ELIGIBILITY_CHECKS)[number];
export type EligibilityResult = 'pass' | 'fail' | 'unknown';

export type EligibilityCheck = {
  check: EligibilityCheckName;
  result: EligibilityResult;
  reason: string;
};

export type EligibilityReport = {
  eligible: boolean;
  reasons: string[];
  checks: EligibilityCheck[];
  policyVersion: number;
};

const DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type SampleFacts = {
  policyVersion: number;
  provider: string;
  deploymentName: string;
  expiresFresh: boolean;
  exchangeComplete: boolean | null;
  textOnly: boolean | null;
  requiredCapabilities: string[] | null;
  sourceLocation: string | null;
  contentBytes: number;
};

type PolicyFacts = {
  policyVersion: number;
  mode: string;
  contentCapture: boolean;
  replay: boolean;
  allowedProviders: string[];
  allowedDeployments: string[];
} | null;

type TargetFacts = {
  name: string;
  enabled: boolean;
  connectionEnabled: boolean;
  provider: string;
  location: string | null;
  capabilities: string[];
} | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseEligibilityBody(body: unknown): { deployment: string } {
  if (!isRecord(body)) {
    throw invalidRequest('deployment', 'invalid_parameter', 'deployment is required.');
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'deployment') {
    throw invalidRequest('deployment', 'invalid_parameter', 'deployment is required.');
  }
  const deployment = body.deployment;
  if (typeof deployment !== 'string' || !DEPLOYMENT_NAME.test(deployment) || deployment === 'auto') {
    throw invalidRequest('deployment', 'invalid_parameter', 'deployment is invalid.');
  }
  return { deployment };
}

function check(name: EligibilityCheckName, result: EligibilityResult, reason: string): EligibilityCheck {
  return { check: name, result, reason };
}

export function evaluateSampleEligibility(input: {
  sample: SampleFacts;
  policy: PolicyFacts;
  target: TargetFacts;
  allowedRegions: readonly string[];
}): EligibilityReport {
  const policy = input.policy;
  const target = input.target;
  const captureAllowed = policy !== null && policy.mode === 'encrypted_sample' && policy.contentCapture;
  const replayAllowed = policy !== null && policy.replay;
  const deploymentAllowed =
    target !== null &&
    target.enabled &&
    target.connectionEnabled &&
    policy !== null &&
    policy.allowedDeployments.includes(target.name);
  const completeness = input.sample.exchangeComplete;
  const textOnly = input.sample.textOnly;
  const required = input.sample.requiredCapabilities;
  const regions = input.allowedRegions;

  let location: EligibilityCheck;
  if (target === null) {
    location = check('provider_location', 'unknown', 'content_inspection');
  } else if (policy === null || !policy.allowedProviders.includes(target.provider)) {
    location = check('provider_location', 'fail', 'provider_denied');
  } else if (regions.length > 0 && (target.location === null || !regions.includes(target.location))) {
    location = check('provider_location', 'fail', 'residency_denied');
  } else if (
    input.sample.sourceLocation !== null &&
    target.location !== null &&
    input.sample.sourceLocation !== target.location
  ) {
    location = check('provider_location', 'fail', 'residency_denied');
  } else if (input.sample.sourceLocation !== null && target.location === null) {
    location = check('provider_location', 'unknown', 'content_inspection');
  } else {
    location = check('provider_location', 'pass', 'pass');
  }

  let capabilities: EligibilityCheck;
  if (required === null) {
    capabilities = check('target_model_capabilities', 'unknown', 'content_inspection');
  } else if (target === null) {
    capabilities = check('target_model_capabilities', 'unknown', 'content_inspection');
  } else if (!required.every((name) => target.capabilities.includes(name))) {
    capabilities = check('target_model_capabilities', 'fail', 'capability_mismatch');
  } else {
    capabilities = check('target_model_capabilities', 'pass', 'pass');
  }

  const checks: EligibilityCheck[] = [
    completeness === null
      ? check('sample_completeness', 'unknown', 'content_inspection')
      : completeness
        ? check('sample_completeness', 'pass', 'pass')
        : check('sample_completeness', 'fail', 'incomplete'),
    input.sample.contentBytes > 0
      ? check('content_availability', 'pass', 'pass')
      : check('content_availability', 'fail', 'content_missing'),
    captureAllowed
      ? check('capture_authorization', 'pass', 'pass')
      : check('capture_authorization', 'fail', 'capture_denied'),
    replayAllowed
      ? check('replay_authorization', 'pass', 'pass')
      : check('replay_authorization', 'fail', 'replay_denied'),
    input.sample.expiresFresh
      ? check('expiry_revocation', 'pass', 'pass')
      : check('expiry_revocation', 'fail', 'expired'),
    deploymentAllowed
      ? check('target_deployment_permission', 'pass', 'pass')
      : check('target_deployment_permission', 'fail', 'deployment_unauthorized'),
    capabilities,
    location,
    textOnly === null
      ? check('tool_or_multimodal', 'unknown', 'content_inspection')
      : textOnly
        ? check('tool_or_multimodal', 'pass', 'pass')
        : check('tool_or_multimodal', 'fail', 'tool_or_multimodal'),
  ];
  const reasons = checks.filter((item) => item.result !== 'pass').map((item) => item.reason);
  return {
    eligible: reasons.length === 0,
    reasons,
    checks,
    policyVersion: policy?.policyVersion ?? input.sample.policyVersion,
  };
}

export async function readSampleEligibility(
  client: PoolClient,
  sampleId: string,
  deployment: string,
): Promise<EligibilityReport | null> {
  const sample = await client.query<{
    policy_version: number;
    provider: string;
    deployment_name: string;
    expires_fresh: boolean;
    exchange_complete: boolean | null;
    text_only: boolean | null;
    required_capabilities: string[] | null;
    source_location: string | null;
    content_bytes: number;
  }>(
    `SELECT policy_version, provider, deployment_name,
            expires_at > statement_timestamp() AS expires_fresh,
            exchange_complete, text_only, required_capabilities, source_location,
            content_bytes
     FROM request_samples
     WHERE id = $1`,
    [sampleId],
  );
  const row = sample.rows[0];
  if (row === undefined) return null;
  const policyResult = await client.query<{
    policy_version: number;
    mode: string;
    content_capture: boolean;
    replay_permitted: boolean;
    allowed_providers: string[];
    allowed_deployments: string[];
  }>(
    `SELECT policy_version, mode, content_capture, replay_permitted, allowed_providers, allowed_deployments
     FROM sample_policies
     ORDER BY policy_version DESC
     LIMIT 1`,
  );
  const policyRow = policyResult.rows[0];
  const targetResult = await client.query<{
    name: string;
    enabled: boolean;
    connection_enabled: boolean;
    provider: string;
    location: string | null;
    capabilities: string[];
  }>(
    `SELECT d.name, d.enabled, c.enabled AS connection_enabled, c.provider, c.location, d.capabilities
     FROM model_deployments d
     JOIN provider_connections c
       ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
     WHERE d.name = $1`,
    [deployment],
  );
  const targetRow = targetResult.rows[0];
  const regionResult = await client.query<{ allowed_regions: string[] }>(
    `SELECT allowed_regions
     FROM fallback_policies
     ORDER BY policy_version DESC
     LIMIT 1`,
  );
  return evaluateSampleEligibility({
    sample: {
      policyVersion: row.policy_version,
      provider: row.provider,
      deploymentName: row.deployment_name,
      expiresFresh: row.expires_fresh === true,
      exchangeComplete: row.exchange_complete,
      textOnly: row.text_only,
      requiredCapabilities: row.required_capabilities,
      sourceLocation: row.source_location,
      contentBytes: Number(row.content_bytes),
    },
    policy:
      policyRow === undefined
        ? null
        : {
            policyVersion: policyRow.policy_version,
            mode: policyRow.mode,
            contentCapture: policyRow.content_capture,
            replay: policyRow.replay_permitted,
            allowedProviders: policyRow.allowed_providers,
            allowedDeployments: policyRow.allowed_deployments,
          },
    target:
      targetRow === undefined
        ? null
        : {
            name: targetRow.name,
            enabled: targetRow.enabled,
            connectionEnabled: targetRow.connection_enabled,
            provider: targetRow.provider,
            location: targetRow.location,
            capabilities: targetRow.capabilities ?? [],
          },
    allowedRegions: regionResult.rows[0]?.allowed_regions ?? [],
  });
}
