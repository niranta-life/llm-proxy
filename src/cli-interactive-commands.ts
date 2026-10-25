export type InteractiveAction = 'create' | 'update' | 'validate';

const CREATE = {
  'provision-tenant': ['name', 'label'],
  'add-key': ['tenant-id', 'label'],
  'register-openai-connection': ['tenant-id', 'api-key'],
  'register-anthropic-connection': ['tenant-id', 'api-key', 'endpoint', 'workspace-id'],
  'register-vertex-connection': ['tenant-id', 'api-key', 'auth-mode', 'project', 'location', 'endpoint', 'service-account', 'api-version'],
  'register-xai-connection': ['tenant-id', 'api-key', 'endpoint', 'auth-mode', 'project', 'location', 'service-account', 'api-version'],
  'register-openrouter-connection': ['tenant-id', 'api-key', 'endpoint', 'auth-mode', 'project', 'location', 'service-account', 'api-version'],
  'register-dgx-connection': ['tenant-id', 'api-key', 'endpoint', 'auth-mode', 'project', 'location', 'service-account', 'api-version'],
  'register-deployment': ['tenant-id', 'name', 'upstream-model', 'timeout-ms', 'capabilities', 'enabled', 'provider', 'default-max-output-tokens', 'downstream-providers', 'data-collection', 'allow-fallbacks', 'require-serving-provider'],
  'register-price': ['provider', 'upstream-model', 'effective-at', 'source', 'status', 'location', 'service-tier', 'serving-provider', 'input-rate', 'output-rate', 'cache-read-rate', 'cache-write-rate', 'thinking-rate', 'request-fee', 'allocated-rate'],
  'approve-private-endpoint': ['tenant-id', 'host', 'port', 'addresses', 'tls-verify', 'health-endpoint'],
} as const;

const UPDATE = {
  'revoke-key': ['tenant-id', 'key-id'],
  'set-openai-credential': ['tenant-id', 'api-key'],
  'set-anthropic-credential': ['tenant-id', 'api-key'],
  'set-connection-enabled': ['tenant-id', 'enabled', 'provider'],
  'set-deployment-enabled': ['tenant-id', 'name', 'enabled'],
  'set-alias': ['tenant-id', 'alias', 'deployment'],
  'set-tenant-streaming': ['tenant-id', 'enabled'],
  'set-deployment-streaming': ['tenant-id', 'deployment', 'enabled', 'connect-timeout-ms', 'idle-timeout-ms', 'total-timeout-ms', 'backpressure-timeout-ms'],
  'set-deployment-concurrency': ['tenant-id', 'deployment', 'max-concurrency'],
  'set-deployment-health': ['tenant-id', 'deployment', 'status'],
  'set-deployment-service-tier': ['tenant-id', 'deployment', 'service-tier'],
  'reconcile-attempt-cost': ['tenant-id', 'attempt-id'],
  'set-execution-policy': ['tenant-id', 'deployment', 'retries', 'connection-deadline-ms', 'attempt-deadline-ms', 'total-deadline-ms', 'initial-backoff-ms', 'max-backoff-ms'],
  'set-deployment-breaker': ['tenant-id', 'deployment', 'enabled', 'window-ms', 'min-samples', 'failure-threshold', 'cooldown-ms', 'max-probes'],
  'reset-deployment-breaker': ['tenant-id', 'deployment'],
  'set-fallback-policy': ['tenant-id', 'alias', 'enabled', 'deployments', 'failures', 'max-attempts', 'capabilities', 'providers', 'data-collection', 'regions', 'min-remaining-deadline-ms'],
  'set-deployment-context-limit': ['tenant-id', 'deployment', 'context-limit'],
  'set-deployment-data-collection': ['tenant-id', 'deployment', 'data-collection'],
  'set-tenant-limits': ['tenant-id', 'mode', 'requests-per-minute', 'concurrent-requests', 'concurrent-streams', 'token-rate', 'lease-ms'],
  'set-api-key-limits': ['tenant-id', 'key-id', 'mode', 'requests-per-minute', 'concurrent-requests', 'concurrent-streams', 'token-rate'],
  'set-connection-limit': ['tenant-id', 'provider', 'mode', 'max-concurrency', 'share-group'],
  'set-deployment-limit': ['tenant-id', 'deployment', 'mode', 'max-concurrency'],
  'set-tenant-budget': ['tenant-id', 'mode', 'monthly-amount'],
  'recover-budget': ['tenant-id'],
  'set-sample-policy': ['tenant-id', 'mode', 'content-capture', 'streaming-capture', 'replay', 'judge-disclosure', 'sample-rate', 'max-sample-bytes', 'max-sample-count', 'retention-seconds', 'classifications', 'providers', 'deployments'],
  'set-deployment-data-class': ['tenant-id', 'deployment', 'data-class'],
  'delete-sample': ['tenant-id', 'sample-id'],
  'cleanup-expired-samples': ['tenant-id'],
} as const;

const VALIDATE = {
  'validate-deployment': ['tenant-id', 'deployment', 'status'],
  'validate-vertex-credential': ['tenant-id'],
  'validate-vertex-access': ['tenant-id'],
  'test-vertex-inference': ['tenant-id', 'deployment'],
  'list-private-models': ['tenant-id', 'deployment'],
  'probe-private-health': ['tenant-id', 'deployment'],
  'show-fallback-policy': ['tenant-id', 'alias'],
  'list-inference': ['tenant-id'],
  'show-sample-policy': ['tenant-id'],
  'show-sample-stats': ['tenant-id'],
} as const;

export const INTERACTIVE_GROUPS = {
  create: CREATE,
  update: UPDATE,
  validate: VALIDATE,
} as const;

export function interactiveFields(action: string, command: string): readonly string[] | undefined {
  if (action !== 'create' && action !== 'update' && action !== 'validate') return undefined;
  const fields = INTERACTIVE_GROUPS[action][command as keyof (typeof INTERACTIVE_GROUPS)[typeof action]];
  return fields === undefined ? undefined : fields;
}
