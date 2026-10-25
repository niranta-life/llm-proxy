// Plain-language text for the guided interactive CLI.
// The field lists live in cli-interactive-commands.ts; this file only explains them.

export const ACTION_HELP = {
  create: 'Add tenants, secrets, provider connections, deployments, and prices',
  update: 'Change secrets, keys, aliases, streaming, limits, budgets, and policies',
  validate: 'Check deployments and providers, or show the current setup',
} as const;

export const COMMAND_HELP: Readonly<Record<string, string>> = {
  'provision-tenant': 'Create a tenant and print its first secret',
  'add-key': 'Add another secret for a tenant',
  'register-openai-connection': 'Connect a tenant to OpenAI',
  'register-anthropic-connection': 'Connect a tenant to Anthropic',
  'register-vertex-connection': 'Connect a tenant to Google Vertex AI',
  'register-xai-connection': 'Connect a tenant to xAI (Grok)',
  'register-openrouter-connection': 'Connect a tenant to OpenRouter',
  'register-dgx-connection': 'Connect a tenant to a private DGX endpoint',
  'register-deployment': 'Add a model that callers can ask for',
  'register-price': 'Record the price of a provider model',
  'approve-private-endpoint': 'Allow a private endpoint host and pin its addresses',
  'revoke-key': 'Turn off one tenant secret',
  'set-openai-credential': 'Replace the OpenAI key',
  'set-anthropic-credential': 'Replace the Anthropic key',
  'set-connection-enabled': 'Turn a provider connection on or off',
  'set-deployment-enabled': 'Turn a deployment on or off',
  'set-alias': 'Point an alias, such as auto, at a deployment',
  'set-tenant-streaming': 'Turn streaming on or off for a tenant',
  'set-deployment-streaming': 'Set streaming and its timeouts for a deployment',
  'set-deployment-concurrency': 'Cap parallel requests to a deployment',
  'set-deployment-health': 'Record a deployment health status',
  'set-deployment-service-tier': 'Set or clear the provider service tier',
  'reconcile-attempt-cost': 'Price one attempt again',
  'set-execution-policy': 'Set retries and deadlines for a deployment',
  'set-deployment-breaker': 'Set up the circuit breaker for a deployment',
  'reset-deployment-breaker': 'Close an open circuit breaker',
  'set-fallback-policy': 'Choose backup deployments for an alias',
  'set-deployment-context-limit': 'Set the context window size of a deployment',
  'set-deployment-data-collection': 'Record if the provider may keep request data',
  'set-tenant-limits': 'Set rate and concurrency limits for a tenant',
  'set-api-key-limits': 'Set limits for one tenant secret',
  'set-connection-limit': 'Cap parallel requests to a provider connection',
  'set-deployment-limit': 'Cap parallel requests to a deployment',
  'set-tenant-budget': 'Set a monthly spend budget for a tenant',
  'recover-budget': 'Close finished attempts that still hold budget',
  'validate-deployment': 'Record the validation status of a deployment',
  'validate-vertex-credential': 'Check the Vertex credential',
  'validate-vertex-access': 'Check access to the Vertex project',
  'test-vertex-inference': 'Send one test request through Vertex',
  'list-private-models': 'List the models on the private endpoint',
  'probe-private-health': 'Check the private endpoint health',
  'show-fallback-policy': 'Show the fallback policy for an alias',
  'list-inference': 'Show the connections, deployments, and aliases of a tenant',
  'set-sample-policy': 'Set whether a tenant stores encrypted chat samples. Disabled and metadata-only modes store no content.',
  'set-deployment-data-class': 'Set the data class of a deployment',
  'show-sample-policy': 'Show the sample policy for a tenant',
  'delete-sample': 'Delete one encrypted sample for a tenant',
  'cleanup-expired-samples': 'Delete expired and revoked samples for a tenant',
  'show-sample-stats': 'Show retained sample counts and task coverage',
};

// Commands whose result includes a tenant secret that is shown only once.
export const PRINTS_SECRET: ReadonlySet<string> = new Set(['provision-tenant', 'add-key']);

// Fields whose values must not be shown again on screen.
export const SECRET_FIELDS: ReadonlySet<string> = new Set(['api-key']);

const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  'provision-tenant': ['name'],
};

export function isRequired(command: string, field: string): boolean {
  if (field === 'tenant-id') return true;
  return REQUIRED[command]?.includes(field) ?? false;
}

const COMMAND_FIELD_HINTS: Readonly<Record<string, string>> = {
  'provision-tenant.name': 'Tenant name, for example acme.',
  'provision-tenant.label': 'Label for the first secret, for example ops.',
  'register-deployment.name': 'Deployment name. Callers send this as model.',
  'validate-deployment.status': 'unvalidated, valid, invalid, or validated_mock.',
  'set-deployment-health.status': 'unknown, healthy, or unhealthy.',
  'register-price.status': 'verified or unverified.',
  'set-tenant-budget.mode': 'observe, hard, or disabled.',
  'set-api-key-limits.mode': 'observe or hard. none removes the key limits.',
  'set-sample-policy.mode': 'disabled, metadata_only, or encrypted_sample.',
  'set-deployment-data-class.data-class': 'public, internal, confidential, restricted, or none.',
};

const FIELD_HINTS: Readonly<Record<string, string>> = {
  'tenant-id': 'Tenant id. provision-tenant prints it.',
  'key-id': 'Secret id. provision-tenant and add-key print it.',
  'attempt-id': 'Attempt id from the metrics or cost output.',
  label: 'Free-text label to tell secrets apart.',
  'api-key': 'Provider API key. It is stored encrypted.',
  enabled: 'true or false.',
  deployment: 'Deployment name.',
  deployments: 'Deployment names, comma-separated, in try order.',
  alias: 'Alias name, for example auto.',
  'upstream-model': 'Model id at the provider, for example gpt-4o-mini.',
  capabilities: 'Request fields to allow, comma-separated, for example temperature,stop.',
  provider: 'openai, anthropic, vertex, xai, openrouter, or dgx.',
  mode: 'observe (record only) or hard (enforce).',
  'data-collection': 'allow or deny.',
  'auth-mode': 'Vertex: service_account (default) or adc.',
  endpoint: 'Base URL. Leave blank to use the provider default, if it has one.',
  'service-tier': 'Tier name, or none to clear it.',
  addresses: 'IP addresses to pin, comma-separated.',
  'tls-verify': 'true or false.',
  'effective-at': 'Start time of the price, ISO 8601.',
  'content-capture': 'true or false. false stores no chat content.',
  'streaming-capture': 'true or false. false stores no streamed text. The default is false.',
  replay: 'true or false. false denies future replay.',
  'judge-disclosure': 'true or false. false denies future judge disclosure.',
  'sample-rate': 'A rate from 0 to 1. Use at most 6 decimal places.',
  'max-sample-bytes': 'Largest sample in bytes, from 0 to 1000000.',
  'max-sample-count': 'Most open samples, from 0 to 1000000. Omit it on encrypted capture to keep 100.',
  'retention-seconds': 'How long a sample is kept, in seconds. Omit it on encrypted capture to keep samples for seven days.',
  'recent-share': 'Share of the cap kept for recent samples, from 0 to 1. The default is 0.6.',
  'sample-id': 'Sample id from the sample list.',
  classifications: 'Approved data classes, comma-separated.',
  'data-class': 'public, internal, confidential, restricted, or none.',
};

export function fieldHint(command: string, field: string): string | undefined {
  const specific = COMMAND_FIELD_HINTS[`${command}.${field}`] ?? FIELD_HINTS[field];
  if (specific !== undefined) return specific;
  if (field.endsWith('-ms')) return 'Milliseconds.';
  return undefined;
}
