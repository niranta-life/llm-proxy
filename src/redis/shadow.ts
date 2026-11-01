import { readFileSync } from 'node:fs';
import { createClient } from 'redis';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { ActiveRedis } from '../inference/active-decide.js';
import { loadActiveScripts } from './active-quota.js';
import { checkHotCounters, loadTokenBucketScript, type RateShadowInput } from './hot-counters.js';

export type RedisLinkState = 'disabled' | 'connected' | 'unavailable';
export type RedisErrorClass = 'auth' | 'tls' | 'unavailable' | null;
export type ShadowDecision = 'allow' | 'deny' | 'unknown';
export type RedisCircuit = 'off' | 'closed' | 'open' | 'half_open';

export type RedisHealth = {
  mode: 'postgres' | 'redis_shadow' | 'redis_active';
  redis: RedisLinkState;
  connectFailures: number;
  reconnects: number;
  pings: number;
  lastError: RedisErrorClass;
  shadowChecks: 'off' | 'on';
  comparisons: number;
  agreements: number;
  disagreements: number;
  unknownResults: number;
  redisAllows: number;
  redisDenies: number;
  lastPostgres: 'allow' | 'deny' | null;
  lastRedis: ShadowDecision | null;
  lastDurationMs: number | null;
  scriptLoads: number;
  scriptMisses: number;
  circuit: RedisCircuit;
  activeAllows: number;
  activeDenies: number;
  fallbackDenies: number;
  epochCloses: number;
  lastRecoveryMs: number | null;
};

export type RedisShadow = {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): RedisHealth;
  observeRates(input: RateShadowInput): Promise<void>;
  active(): ActiveRedis;
};

export function disabledRedisHealth(): RedisHealth {
  return {
    mode: 'postgres',
    redis: 'disabled',
    connectFailures: 0,
    reconnects: 0,
    pings: 0,
    lastError: null,
    shadowChecks: 'off',
    comparisons: 0,
    agreements: 0,
    disagreements: 0,
    unknownResults: 0,
    redisAllows: 0,
    redisDenies: 0,
    lastPostgres: null,
    lastRedis: null,
    lastDurationMs: null,
    scriptLoads: 0,
    scriptMisses: 0,
    circuit: 'off',
    activeAllows: 0,
    activeDenies: 0,
    fallbackDenies: 0,
    epochCloses: 0,
    lastRecoveryMs: null,
  };
}

function idleActive(): ActiveRedis {
  return {
    timeoutMs: 1000,
    async recoverIfDue(): Promise<'ready' | 'blocked'> {
      return 'blocked';
    },
    async command(): Promise<never> {
      throw new Error('redis disabled');
    },
    noteFailure(): void {},
    noteActive(): void {},
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function classify(error: unknown): Exclude<RedisErrorClass, null> {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  const text = `${name} ${message}`;
  if (/WRONGPASS|NOAUTH|invalid username-password/i.test(text)) return 'auth';
  if (/certificate|CERT_|UNABLE_TO_|ERR_TLS|\bTLS\b|altnames|does not match/i.test(text)) return 'tls';
  return 'unavailable';
}

export function createRedisShadow(config: Config, logger: Logger): RedisShadow {
  if (config.redis === null || (config.rateLimitMode !== 'redis_shadow' && config.rateLimitMode !== 'redis_active')) {
    return {
      async start(): Promise<void> {},
      async stop(): Promise<void> {},
      health: disabledRedisHealth,
      async observeRates(): Promise<void> {},
      active: idleActive,
    };
  }

  const settings = config.redis;
  let client: ReturnType<typeof createClient> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let connectedBefore = false;
  let state: RedisLinkState = 'unavailable';
  let connectFailures = 0;
  let reconnects = 0;
  let pings = 0;
  let lastError: RedisErrorClass = null;
  let comparisons = 0;
  let agreements = 0;
  let disagreements = 0;
  let unknownResults = 0;
  let redisAllows = 0;
  let redisDenies = 0;
  let lastPostgres: 'allow' | 'deny' | null = null;
  let lastRedis: ShadowDecision | null = null;
  let lastDurationMs: number | null = null;
  let scriptLoads = 0;
  let scriptMisses = 0;
  const shadowChecks = config.redisShadowChecks ? 'on' : 'off';
  const activeMode = config.rateLimitMode === 'redis_active';
  const healthMode = activeMode ? 'redis_active' : 'redis_shadow';
  let circuit: RedisCircuit = activeMode ? 'closed' : 'off';
  let openedAt = 0;
  let recovering = false;
  let activeAllows = 0;
  let activeDenies = 0;
  let fallbackDenies = 0;
  let epochCloses = 0;
  let lastRecoveryMs: number | null = null;

  function openBreaker(): void {
    if (!activeMode) return;
    circuit = 'open';
    openedAt = Date.now();
  }

  function noteFailure(error: unknown): void {
    connectFailures += 1;
    const kind = classify(error);
    if (lastError === null || lastError === 'unavailable' || kind !== 'unavailable') lastError = kind;
    state = 'unavailable';
    openBreaker();
    logger.warn('redis shadow unavailable', { error: kind });
  }

  function health(): RedisHealth {
    return {
      mode: healthMode,
      redis: state,
      connectFailures,
      reconnects,
      pings,
      lastError,
      shadowChecks,
      comparisons,
      agreements,
      disagreements,
      unknownResults,
      redisAllows,
      redisDenies,
      lastPostgres,
      lastRedis,
      lastDurationMs,
      scriptLoads,
      scriptMisses,
      circuit,
      activeAllows,
      activeDenies,
      fallbackDenies,
      epochCloses,
      lastRecoveryMs,
    };
  }

  function active(): ActiveRedis {
    return {
      timeoutMs: settings.connectTimeoutMs,
      async recoverIfDue(closeEpochs: () => Promise<number>): Promise<'ready' | 'blocked'> {
        if (!activeMode || stopped) return 'blocked';
        if (circuit === 'closed') {
          if (client !== null && client.isReady) return 'ready';
          openBreaker();
          return 'blocked';
        }
        if (circuit !== 'open' || recovering) return 'blocked';
        if (Date.now() - openedAt < settings.breakerCooldownMs) return 'blocked';
        recovering = true;
        circuit = 'half_open';
        const started = Date.now();
        try {
          const current = client;
          if (current === null || !current.isReady) throw new Error('unavailable');
          let timerId: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_resolve, reject) => {
            timerId = setTimeout(() => reject(new Error('timeout')), settings.connectTimeoutMs);
            timerId.unref();
          });
          try {
            await Promise.race([current.ping(), timeout]);
          } finally {
            if (timerId !== undefined) clearTimeout(timerId);
          }
          const closed = await closeEpochs();
          epochCloses += closed;
          circuit = 'closed';
          lastRecoveryMs = Date.now() - started;
          return 'ready';
        } catch (error) {
          if (!stopped) noteFailure(error);
          else openBreaker();
          return 'blocked';
        } finally {
          recovering = false;
          if (circuit === 'half_open') openBreaker();
        }
      },
      async command<T>(run: (commandClient: { sendCommand(args: string[]): Promise<unknown> }) => Promise<T>): Promise<T> {
        const current = client;
        if (!activeMode || stopped || circuit !== 'closed' || current === null || !current.isReady) {
          if (activeMode && circuit === 'closed') openBreaker();
          throw new Error('redis circuit is not ready');
        }
        const started = Date.now();
        try {
          return await run({ sendCommand: (args) => current.sendCommand(args) });
        } finally {
          lastDurationMs = Date.now() - started;
        }
      },
      noteFailure(): void {
        openBreaker();
      },
      noteActive(decision: 'allow' | 'deny' | 'fallback'): void {
        if (decision === 'allow') activeAllows += 1;
        else if (decision === 'deny') activeDenies += 1;
        else fallbackDenies += 1;
      },
    };
  }

  async function observeRates(input: RateShadowInput): Promise<void> {
    if (!config.redisShadowChecks) return;
    const current = client;
    let decision: ShadowDecision = 'unknown';
    let durationMs = 0;
    let reloaded = false;
    try {
      if (current !== null && !stopped && current.isReady) {
        const result = await checkHotCounters(
          { sendCommand: (args) => current.sendCommand(args) },
          {
            tenantId: input.tenantId,
            apiKeyId: input.apiKeyId,
            attemptId: input.attemptId,
            tokenCost: input.tokenCost,
            limits: input.limits,
          },
          settings.connectTimeoutMs,
        );
        decision = result.decision;
        durationMs = result.durationMs;
        reloaded = result.reloaded;
      }
    } catch {
      decision = 'unknown';
    }
    comparisons += 1;
    lastPostgres = input.postgresDecision;
    lastRedis = decision;
    lastDurationMs = durationMs;
    if (reloaded) {
      scriptMisses += 1;
      scriptLoads += 1;
    }
    if (decision === 'unknown') unknownResults += 1;
    else if (decision === input.postgresDecision) agreements += 1;
    else disagreements += 1;
    if (decision === 'allow') redisAllows += 1;
    if (decision === 'deny') redisDenies += 1;
  }

  async function ping(): Promise<void> {
    const current = client;
    if (current === null || stopped || !current.isReady) return;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timerId = setTimeout(() => reject(new Error('timeout')), settings.connectTimeoutMs);
      timerId.unref();
    });
    try {
      await Promise.race([current.ping(), timeout]);
      if (!stopped) pings += 1;
    } catch (error) {
      if (stopped) return;
      noteFailure(error);
      if (error instanceof Error && error.message === 'timeout' && current.isOpen) {
        try {
          await current.disconnect();
        } catch {
          // The socket is already closed.
        }
        if (!stopped) {
          void current.connect().catch((connectError: unknown) => {
            if (!stopped) noteFailure(connectError);
          });
        }
      }
    } finally {
      if (timerId !== undefined) clearTimeout(timerId);
    }
  }

  return {
    health,
    observeRates,
    active,
    async start(): Promise<void> {
      const url = new URL(settings.url);
      // CLIENT SETINFO runs before AUTH. The default user is off, so skip it.
      const socket: {
        connectTimeout: number;
        reconnectStrategy: (retries: number) => number | Error;
        tls?: true;
        ca?: Buffer;
        cert?: Buffer;
        key?: Buffer;
        rejectUnauthorized?: boolean;
        servername?: string;
      } = {
        connectTimeout: settings.connectTimeoutMs,
        reconnectStrategy: (retries: number) => {
          if (stopped) return new Error('stopped');
          return Math.min(50 * Math.max(retries, 1), settings.reconnectTimeoutMs);
        },
      };
      if (settings.tls) {
        socket.tls = true;
        socket.rejectUnauthorized = true;
        socket.servername = url.hostname;
        if (settings.caFile !== null) socket.ca = readFileSync(settings.caFile);
        if (settings.certFile !== null) socket.cert = readFileSync(settings.certFile);
        if (settings.keyFile !== null) socket.key = readFileSync(settings.keyFile);
      }
      const created = createClient({
        url: settings.url,
        username: settings.username,
        password: settings.password,
        disableClientInfo: true,
        disableOfflineQueue: true,
        socket,
      });
      client = created;
      created.on('error', (error: unknown) => {
        if (!stopped) noteFailure(error);
      });
      created.on('ready', () => {
        if (stopped) return;
        if (connectedBefore) reconnects += 1;
        connectedBefore = true;
        state = 'connected';
        lastError = null;
        logger.info('redis shadow connected');
      });
      created.on('end', () => {
        if (!stopped) state = 'unavailable';
      });
      const pending = created.connect().then(
        () => undefined,
        (error: unknown) => {
          if (!stopped) noteFailure(error);
        },
      );
      await Promise.race([pending, sleep(settings.connectTimeoutMs)]);
      if (config.redisShadowChecks && !stopped && created.isReady) {
        const loaded = await loadTokenBucketScript({ sendCommand: (args) => created.sendCommand(args) });
        if (loaded) scriptLoads += 1;
      }
      if (activeMode && !stopped && created.isReady) {
        const loaded = await loadActiveScripts({ sendCommand: (args) => created.sendCommand(args) });
        if (loaded) scriptLoads += 1;
      }
      const period = Math.max(100, Math.min(settings.reconnectTimeoutMs, 1000));
      timer = setInterval(() => {
        void ping();
      }, period);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      const current = client;
      client = null;
      if (current === null) return;
      try {
        if (current.isOpen) {
          await Promise.race([current.quit(), sleep(settings.connectTimeoutMs)]);
        }
      } catch {
        // The socket is already closed.
      }
      try {
        if (current.isOpen) await current.disconnect();
      } catch {
        // The socket is already closed.
      }
    },
  };
}
