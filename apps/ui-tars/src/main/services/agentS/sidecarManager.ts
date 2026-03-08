/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  ChildProcess,
  SpawnOptionsWithoutStdio,
  spawn as nodeSpawn,
} from 'node:child_process';

import { logger } from '@main/logger';
import {
  type AgentSCorrelationIds,
  emitAgentSTelemetry,
  sanitizeCommandArgs,
} from './telemetry';
import { isExplicitHealthyHealthPayload } from './sidecarSchemas';

export type SidecarMode = 'embedded' | 'external';

export type SidecarState =
  | 'starting'
  | 'running'
  | 'unhealthy'
  | 'timeout'
  | 'stopping'
  | 'stopped';

export type SidecarFailureReason =
  | 'startup_timeout'
  | 'startup_failed'
  | 'invalid_endpoint'
  | 'health_http_error'
  | 'health_timeout'
  | 'heartbeat_failed'
  | 'heartbeat_timeout'
  | 'child_process_exit'
  | 'stop_requested';

export type SidecarStatus = {
  state: SidecarState;
  mode: SidecarMode | null;
  healthy: boolean;
  endpoint: string | null;
  pid: number | null;
  checkedAt: number;
  lastHeartbeatAt: number | null;
  httpStatus?: number;
  reason?: SidecarFailureReason;
  error?: string;
};

export type AgentSFallbackClass =
  | 'timeout'
  | 'unavailable'
  | 'invalid_output'
  | 'degraded_fallback';

export type AgentSCircuitBreakerState = 'closed' | 'open' | 'half_open';

export type AgentSCircuitBreakerStatus = {
  state: AgentSCircuitBreakerState;
  failureThreshold: number;
  cooldownMs: number;
  consecutiveFailures: number;
  openedAt: number | null;
  nextProbeAt: number | null;
  canProbe: boolean;
  lastFailureAt: number | null;
  lastFailureCode: string | null;
  lastFailureClass: AgentSFallbackClass | null;
  lastRecoveryAt: number | null;
};

type AgentSCircuitBreakerConfig = {
  failureThreshold: number;
  cooldownMs: number;
};

type AgentSCircuitBreakerMutableState = {
  state: AgentSCircuitBreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  lastFailureAt: number | null;
  lastFailureCode: string | null;
  lastFailureClass: AgentSFallbackClass | null;
  lastRecoveryAt: number | null;
};

type CircuitFailureSource = 'dispatcher' | 'runtime' | 'probe' | 'sidecar';

type CircuitFailureInput = {
  reasonCode?: string | null;
  source?: CircuitFailureSource;
};

type CircuitSuccessInput = {
  source?: 'runtime' | 'probe' | 'dispatcher';
};

export type CircuitDispatchDecision = {
  allowAgentS: boolean;
  reasonCode: string | null;
  breaker: AgentSCircuitBreakerStatus;
  sidecarStatus: SidecarStatus | null;
};

type SidecarBaseConfig = {
  endpoint: string;
  startupTimeoutMs?: number;
  startupPollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  healthTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  healthPath?: string;
};

export type EmbeddedSidecarConfig = SidecarBaseConfig & {
  mode: 'embedded';
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type ExternalSidecarConfig = SidecarBaseConfig & {
  mode: 'external';
};

export type SidecarStartConfig = EmbeddedSidecarConfig | ExternalSidecarConfig;

type SidecarManagerDependencies = {
  spawn: (
    command: string,
    args?: ReadonlyArray<string>,
    options?: SpawnOptionsWithoutStdio,
  ) => ChildProcess;
  fetch: typeof fetch;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
  now: () => number;
};

type HealthProbeResult = {
  healthy: boolean;
  checkedAt: number;
  httpStatus?: number;
  reason?: SidecarFailureReason;
  error?: string;
};

type HealthProbeContext = 'probe' | 'startup' | 'heartbeat';

export const DEFAULT_STARTUP_TIMEOUT_MS = 12_000;
export const DEFAULT_STARTUP_POLL_INTERVAL_MS = 250;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 20_000;
const DEFAULT_HEALTH_PATH = '/health';

const MIN_TIMEOUT_MS = 50;
const MIN_INTERVAL_MS = 100;
const MIN_FAILURE_THRESHOLD = 1;
const EMBEDDED_LAUNCHER_NAME_PATTERN = /^[a-z0-9_.-]+$/i;
const ALLOWED_EMBEDDED_LAUNCHERS = new Set(['agent_s', 'python', 'python3']);

const stripUnsafeLocalEnvArgs = (args: string[] = []): string[] => {
  return args.filter((arg) => {
    const normalized = arg.trim().toLowerCase();
    return (
      normalized !== '--enable_local_env' &&
      !normalized.startsWith('--enable_local_env=')
    );
  });
};

const validateEmbeddedLauncher = (
  command: string,
  args: string[] = [],
): string | null => {
  const normalizedCommand = command.trim().toLowerCase();
  if (
    normalizedCommand.length === 0 ||
    !EMBEDDED_LAUNCHER_NAME_PATTERN.test(normalizedCommand) ||
    !ALLOWED_EMBEDDED_LAUNCHERS.has(normalizedCommand)
  ) {
    return 'Embedded sidecar command must be agent_s, python -m agent_s, or python3 -m agent_s';
  }

  if (normalizedCommand === 'agent_s') {
    return null;
  }

  const moduleFlag = args[0]?.trim();
  const moduleName = args[1]?.trim().toLowerCase();
  if (moduleFlag !== '-m' || moduleName !== 'agent_s') {
    return 'Embedded Python sidecar command must launch agent_s via -m agent_s';
  }

  return null;
};

const normalizeTimeout = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(value, MIN_TIMEOUT_MS);
};

const normalizeInterval = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(value, MIN_INTERVAL_MS);
};

const normalizeFailureThreshold = (
  value: number | undefined,
  fallback: number,
) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(MIN_FAILURE_THRESHOLD, Math.floor(value));
};

const normalizeEnvNumber = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const resolveCircuitBreakerConfig = (): AgentSCircuitBreakerConfig => {
  return {
    failureThreshold: normalizeFailureThreshold(
      normalizeEnvNumber(process.env.AGENT_S_CIRCUIT_BREAKER_FAILURE_THRESHOLD),
      DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    ),
    cooldownMs: normalizeTimeout(
      normalizeEnvNumber(process.env.AGENT_S_CIRCUIT_BREAKER_COOLDOWN_MS),
      DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
    ),
  };
};

const createInitialCircuitBreakerState =
  (): AgentSCircuitBreakerMutableState => ({
    state: 'closed',
    consecutiveFailures: 0,
    openedAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    lastFailureClass: null,
    lastRecoveryAt: null,
  });

export const classifyAgentSFailureReason = (
  reasonCode: string | null | undefined,
): AgentSFallbackClass => {
  if (!reasonCode) {
    return 'degraded_fallback';
  }

  if (
    reasonCode === 'startup_timeout' ||
    reasonCode === 'health_timeout' ||
    reasonCode === 'heartbeat_timeout' ||
    reasonCode === 'AGENT_S_TURN_TIMEOUT'
  ) {
    return 'timeout';
  }

  if (
    reasonCode === 'AGENT_S_PREDICTION_MALFORMED' ||
    reasonCode === 'AGENT_S_TRANSLATION_FAILED' ||
    reasonCode === 'ACTION_NOT_ALLOWED'
  ) {
    return 'invalid_output';
  }

  if (
    reasonCode === 'startup_failed' ||
    reasonCode === 'invalid_endpoint' ||
    reasonCode === 'health_http_error' ||
    reasonCode === 'heartbeat_failed' ||
    reasonCode === 'child_process_exit' ||
    reasonCode === 'stop_requested' ||
    reasonCode === 'AGENT_S_SIDECAR_UNHEALTHY' ||
    reasonCode === 'AGENT_S_TURN_REQUEST_FAILED' ||
    reasonCode === 'feature_flag_disabled' ||
    reasonCode === 'sidecar_health_probe_failed'
  ) {
    return 'unavailable';
  }

  return 'degraded_fallback';
};

const createInitialStatus = (): SidecarStatus => ({
  state: 'stopped',
  mode: null,
  healthy: false,
  endpoint: null,
  pid: null,
  checkedAt: Date.now(),
  lastHeartbeatAt: null,
  reason: 'stop_requested',
});

const resolveHealthUrl = (
  endpoint: string,
  healthPath = DEFAULT_HEALTH_PATH,
) => {
  const parsed = new URL(endpoint);
  const normalizedPath = healthPath.startsWith('/')
    ? healthPath
    : `/${healthPath}`;
  const normalizedEndpointPath = parsed.pathname.replace(/\/+$/, '') || '/';
  const hasDefaultHealthSuffix =
    normalizedEndpointPath.endsWith(DEFAULT_HEALTH_PATH);

  if (hasDefaultHealthSuffix && normalizedPath === DEFAULT_HEALTH_PATH) {
    parsed.pathname = normalizedEndpointPath;
    return parsed.toString();
  }

  const pathname = hasDefaultHealthSuffix
    ? normalizedEndpointPath.slice(0, -DEFAULT_HEALTH_PATH.length)
    : normalizedEndpointPath;
  const normalizedBasePath = pathname === '/' ? '' : pathname;
  parsed.pathname = normalizedBasePath
    ? `${normalizedBasePath}${normalizedPath}`
    : normalizedPath;

  return parsed.toString();
};

export class AgentSSidecarManager {
  private readonly deps: SidecarManagerDependencies;

  private readonly circuitBreakerConfig: AgentSCircuitBreakerConfig;

  private circuitBreakerState: AgentSCircuitBreakerMutableState;

  private status: SidecarStatus = createInitialStatus();

  private child: ChildProcess | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private startPromise: Promise<SidecarStatus> | null = null;

  private startPromiseToken: number | null = null;

  private currentConfig: SidecarStartConfig | null = null;

  private lifecycleToken = 0;

  private heartbeatInFlight = false;

  private dispatchCircuitProbePromise: Promise<CircuitDispatchDecision> | null =
    null;

  private telemetryCorrelation: AgentSCorrelationIds = {};

  private lastFallbackEventSignature: string | null = null;

  constructor(deps: Partial<SidecarManagerDependencies> = {}) {
    this.deps = {
      spawn: nodeSpawn,
      fetch,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      now: Date.now,
      ...deps,
    };
    this.circuitBreakerConfig = resolveCircuitBreakerConfig();
    this.circuitBreakerState = createInitialCircuitBreakerState();
  }

  getStatus(): SidecarStatus {
    return { ...this.status };
  }

  setTelemetryCorrelation(correlation: AgentSCorrelationIds) {
    this.telemetryCorrelation = {
      runId: correlation.runId ?? null,
      sessionId: correlation.sessionId ?? null,
    };
  }

  getCircuitBreakerStatus(): AgentSCircuitBreakerStatus {
    const now = this.deps.now();
    const nextProbeAt = this.circuitBreakerState.openedAt
      ? this.circuitBreakerState.openedAt + this.circuitBreakerConfig.cooldownMs
      : null;

    const canProbe =
      this.circuitBreakerState.state === 'open' &&
      typeof nextProbeAt === 'number' &&
      now >= nextProbeAt;

    return {
      state: this.circuitBreakerState.state,
      failureThreshold: this.circuitBreakerConfig.failureThreshold,
      cooldownMs: this.circuitBreakerConfig.cooldownMs,
      consecutiveFailures: this.circuitBreakerState.consecutiveFailures,
      openedAt: this.circuitBreakerState.openedAt,
      nextProbeAt,
      canProbe,
      lastFailureAt: this.circuitBreakerState.lastFailureAt,
      lastFailureCode: this.circuitBreakerState.lastFailureCode,
      lastFailureClass: this.circuitBreakerState.lastFailureClass,
      lastRecoveryAt: this.circuitBreakerState.lastRecoveryAt,
    };
  }

  async evaluateDispatchCircuit(): Promise<CircuitDispatchDecision> {
    const current = this.getCircuitBreakerStatus();
    if (current.state === 'closed') {
      return {
        allowAgentS: true,
        reasonCode: null,
        breaker: current,
        sidecarStatus: null,
      };
    }

    if (current.state === 'open' && !current.canProbe) {
      return {
        allowAgentS: false,
        reasonCode: 'circuit_breaker_open',
        breaker: current,
        sidecarStatus: null,
      };
    }

    return this.evaluateHalfOpenDispatchCircuit();
  }

  private evaluateHalfOpenDispatchCircuit(): Promise<CircuitDispatchDecision> {
    if (this.dispatchCircuitProbePromise) {
      return this.dispatchCircuitProbePromise;
    }

    this.circuitBreakerState.state = 'half_open';

    const probePromise = (async (): Promise<CircuitDispatchDecision> => {
      const sidecarStatus = await this.health({ probe: true }).catch(
        () => null,
      );
      if (sidecarStatus?.healthy && sidecarStatus.endpoint) {
        const recovered = this.recordCircuitSuccess({ source: 'probe' });
        return {
          allowAgentS: true,
          reasonCode: 'circuit_breaker_recovered',
          breaker: recovered,
          sidecarStatus,
        };
      }

      const failed = this.recordCircuitFailure({
        source: 'probe',
        reasonCode: sidecarStatus?.reason ?? 'sidecar_health_probe_failed',
      });

      return {
        allowAgentS: false,
        reasonCode: 'circuit_breaker_open',
        breaker: failed,
        sidecarStatus,
      };
    })();

    const sharedProbePromise = probePromise.finally(() => {
      if (this.dispatchCircuitProbePromise === sharedProbePromise) {
        this.dispatchCircuitProbePromise = null;
      }
    });

    this.dispatchCircuitProbePromise = sharedProbePromise;
    return sharedProbePromise;
  }

  recordCircuitFailure(
    input: CircuitFailureInput = {},
  ): AgentSCircuitBreakerStatus {
    const now = this.deps.now();
    const reasonCode = input.reasonCode ?? 'runtime_error';
    const failureClass = classifyAgentSFailureReason(reasonCode);
    const previousState = this.circuitBreakerState.state;

    this.circuitBreakerState.lastFailureAt = now;
    this.circuitBreakerState.lastFailureCode = reasonCode;
    this.circuitBreakerState.lastFailureClass = failureClass;

    if (previousState === 'closed') {
      this.circuitBreakerState.consecutiveFailures += 1;
      if (
        this.circuitBreakerState.consecutiveFailures >=
        this.circuitBreakerConfig.failureThreshold
      ) {
        this.circuitBreakerState.state = 'open';
        this.circuitBreakerState.openedAt = now;
      }
    } else {
      this.circuitBreakerState.state = 'open';
      this.circuitBreakerState.openedAt = now;
      this.circuitBreakerState.consecutiveFailures = Math.max(
        this.circuitBreakerState.consecutiveFailures,
        this.circuitBreakerConfig.failureThreshold,
      );
    }

    const didOpen =
      previousState !== 'open' && this.circuitBreakerState.state === 'open';
    const isProbeFailure = input.source === 'probe';
    if (didOpen || isProbeFailure) {
      emitAgentSTelemetry(
        'agent_s.fallback.triggered',
        {
          source: 'agent_s.circuit_breaker',
          reasonCode: didOpen
            ? 'circuit_breaker_open'
            : 'circuit_breaker_probe_failed',
          failureReason: reasonCode,
          failureClass,
          state: this.circuitBreakerState.state,
          consecutiveFailures: this.circuitBreakerState.consecutiveFailures,
          threshold: this.circuitBreakerConfig.failureThreshold,
          cooldownMs: this.circuitBreakerConfig.cooldownMs,
        },
        { level: 'warn', correlation: this.telemetryCorrelation },
      );
      emitAgentSTelemetry(
        'engine_fallback_triggered',
        {
          source: 'agent_s.circuit_breaker',
          reasonCode: didOpen
            ? 'circuit_breaker_open'
            : 'circuit_breaker_probe_failed',
          failureReason: reasonCode,
          failureClass,
          state: this.circuitBreakerState.state,
          consecutiveFailures: this.circuitBreakerState.consecutiveFailures,
          threshold: this.circuitBreakerConfig.failureThreshold,
          cooldownMs: this.circuitBreakerConfig.cooldownMs,
        },
        { level: 'warn', correlation: this.telemetryCorrelation },
      );
    }

    return this.getCircuitBreakerStatus();
  }

  recordCircuitSuccess(
    input: CircuitSuccessInput = {},
  ): AgentSCircuitBreakerStatus {
    const now = this.deps.now();
    const wasProtected =
      this.circuitBreakerState.state !== 'closed' ||
      this.circuitBreakerState.consecutiveFailures > 0;

    this.circuitBreakerState.state = 'closed';
    this.circuitBreakerState.consecutiveFailures = 0;
    this.circuitBreakerState.openedAt = null;
    this.circuitBreakerState.lastFailureAt = null;
    this.circuitBreakerState.lastFailureCode = null;
    this.circuitBreakerState.lastFailureClass = null;
    this.circuitBreakerState.lastRecoveryAt = now;

    if (wasProtected) {
      emitAgentSTelemetry(
        'agent_s.engine.selected',
        {
          selectedRuntime: 'agent_s',
          reasonCode: 'circuit_breaker_recovered',
          source: input.source ?? 'runtime',
          circuitBreakerState: 'closed',
        },
        { correlation: this.telemetryCorrelation },
      );
    }

    return this.getCircuitBreakerStatus();
  }

  async start(config: SidecarStartConfig): Promise<SidecarStatus> {
    if (this.startPromise && this.startPromiseToken === this.lifecycleToken) {
      return this.startPromise;
    }

    const startPromise = this.startInternal(config).finally(() => {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
        this.startPromiseToken = null;
      }
    });

    this.startPromise = startPromise;
    this.startPromiseToken = this.lifecycleToken;
    return startPromise;
  }

  async restart(config?: SidecarStartConfig): Promise<SidecarStatus> {
    const nextConfig = config ?? this.currentConfig;
    if (!nextConfig) {
      throw new Error('No existing sidecar config found for restart');
    }

    await this.stop();
    return this.start(nextConfig);
  }

  async health(options: { probe?: boolean } = {}): Promise<SidecarStatus> {
    if (!options.probe || !this.currentConfig) {
      return this.getStatus();
    }

    const result = await this.probeHealth(this.currentConfig);
    if (result.healthy) {
      this.updateStatus({
        state: 'running',
        healthy: true,
        reason: undefined,
        error: undefined,
        httpStatus: result.httpStatus,
        checkedAt: result.checkedAt,
        lastHeartbeatAt: result.checkedAt,
      });
      return this.getStatus();
    }

    const currentStatus = this.getStatus();
    if (currentStatus.state === 'running' && currentStatus.healthy) {
      return {
        ...currentStatus,
        state: 'unhealthy',
        healthy: false,
        reason: result.reason,
        httpStatus: result.httpStatus,
        error: result.error,
        checkedAt: result.checkedAt,
      };
    }

    this.updateStatus({
      state: 'unhealthy',
      healthy: false,
      reason: result.reason,
      httpStatus: result.httpStatus,
      error: result.error,
      checkedAt: result.checkedAt,
    });

    return this.getStatus();
  }

  async stop(): Promise<SidecarStatus> {
    const stopMarker = ++this.lifecycleToken;
    this.stopHeartbeat();

    const shouldStopChild = this.child !== null;

    emitAgentSTelemetry(
      'agent_s.sidecar.stop',
      {
        phase: 'requested',
        mode: this.status.mode,
        endpoint: this.status.endpoint,
        pid: this.status.pid,
      },
      { correlation: this.telemetryCorrelation },
    );

    this.updateStatus({
      state: 'stopping',
      healthy: false,
      reason: 'stop_requested',
      checkedAt: this.deps.now(),
    });

    if (shouldStopChild) {
      await this.terminateChild(
        normalizeTimeout(
          this.currentConfig?.shutdownTimeoutMs,
          DEFAULT_SHUTDOWN_TIMEOUT_MS,
        ),
      );
    }

    if (stopMarker !== this.lifecycleToken) {
      return this.getStatus();
    }

    this.child = null;
    this.updateStatus({
      state: 'stopped',
      healthy: false,
      pid: null,
      reason: 'stop_requested',
      checkedAt: this.deps.now(),
    });

    emitAgentSTelemetry(
      'agent_s.sidecar.stop',
      {
        phase: 'completed',
        mode: this.status.mode,
        endpoint: this.status.endpoint,
      },
      { correlation: this.telemetryCorrelation },
    );

    return this.getStatus();
  }

  private async startInternal(
    config: SidecarStartConfig,
  ): Promise<SidecarStatus> {
    const lifecycleMarker = ++this.lifecycleToken;
    this.stopHeartbeat();

    if (this.child) {
      await this.terminateChild(
        normalizeTimeout(
          this.currentConfig?.shutdownTimeoutMs,
          DEFAULT_SHUTDOWN_TIMEOUT_MS,
        ),
      );
    }

    if (lifecycleMarker !== this.lifecycleToken) {
      return this.getStatus();
    }

    this.currentConfig = { ...config };
    const safeEmbeddedArgs =
      config.mode === 'embedded'
        ? stripUnsafeLocalEnvArgs(config.args)
        : undefined;

    emitAgentSTelemetry(
      'agent_s.sidecar.start',
      {
        mode: config.mode,
        endpoint: config.endpoint,
        command: config.mode === 'embedded' ? config.command : undefined,
        args:
          config.mode === 'embedded'
            ? sanitizeCommandArgs(safeEmbeddedArgs ?? [])
            : undefined,
      },
      { correlation: this.telemetryCorrelation },
    );

    this.updateStatus({
      state: 'starting',
      mode: config.mode,
      endpoint: config.endpoint,
      healthy: false,
      pid: null,
      reason: undefined,
      error: undefined,
      httpStatus: undefined,
      checkedAt: this.deps.now(),
      lastHeartbeatAt: null,
    });

    if (config.mode === 'embedded') {
      const launcherValidationError = validateEmbeddedLauncher(
        config.command,
        safeEmbeddedArgs ?? [],
      );
      if (launcherValidationError) {
        emitAgentSTelemetry(
          'agent_s.runtime.error',
          {
            source: 'sidecar.spawn_validation',
            mode: config.mode,
            error: launcherValidationError,
          },
          { level: 'error', correlation: this.telemetryCorrelation },
        );
        this.updateStatus({
          state: 'unhealthy',
          healthy: false,
          reason: 'startup_failed',
          error: launcherValidationError,
          checkedAt: this.deps.now(),
        });
        return this.getStatus();
      }

      try {
        this.child = this.deps.spawn(config.command, safeEmbeddedArgs ?? [], {
          cwd: config.cwd,
          env: config.env,
          windowsHide: true,
        });
      } catch (error) {
        emitAgentSTelemetry(
          'agent_s.runtime.error',
          {
            source: 'sidecar.spawn',
            mode: config.mode,
            error: error instanceof Error ? error.message : String(error),
          },
          { level: 'error', correlation: this.telemetryCorrelation },
        );
        this.updateStatus({
          state: 'unhealthy',
          healthy: false,
          reason: 'startup_failed',
          error: error instanceof Error ? error.message : String(error),
          checkedAt: this.deps.now(),
        });
        return this.getStatus();
      }

      this.attachChildListeners(this.child, lifecycleMarker);

      logger.info('[agentS sidecar] spawned sidecar process', {
        command: config.command,
        args: sanitizeCommandArgs(safeEmbeddedArgs ?? []),
        pid: this.child.pid ?? null,
      });

      this.updateStatus({
        pid: this.child.pid ?? null,
      });
    } else {
      logger.info('[agentS sidecar] using external endpoint mode', {
        endpoint: config.endpoint,
      });
    }

    const startupTimeoutMs = normalizeTimeout(
      config.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
    );
    const pollIntervalMs = normalizeInterval(
      config.startupPollIntervalMs,
      DEFAULT_STARTUP_POLL_INTERVAL_MS,
    );
    const startedAt = this.deps.now();

    while (this.deps.now() - startedAt < startupTimeoutMs) {
      if (lifecycleMarker !== this.lifecycleToken) {
        return this.getStatus();
      }

      if (config.mode === 'embedded' && this.child === null) {
        if (
          this.status.reason === 'child_process_exit' ||
          this.status.reason === 'startup_failed'
        ) {
          this.updateStatus({
            state: 'unhealthy',
            healthy: false,
            checkedAt: this.deps.now(),
          });
          return this.getStatus();
        }
      }

      const probe = await this.probeHealth(config, 'startup');
      if (lifecycleMarker !== this.lifecycleToken) {
        return this.getStatus();
      }

      if (probe.healthy) {
        this.updateStatus({
          state: 'running',
          healthy: true,
          reason: undefined,
          error: undefined,
          httpStatus: probe.httpStatus,
          checkedAt: probe.checkedAt,
          lastHeartbeatAt: probe.checkedAt,
        });

        this.startHeartbeat(lifecycleMarker, config);
        return this.getStatus();
      }

      this.updateStatus({
        healthy: false,
        reason: probe.reason,
        error: probe.error,
        httpStatus: probe.httpStatus,
        checkedAt: probe.checkedAt,
      });

      const elapsed = this.deps.now() - startedAt;
      const remaining = startupTimeoutMs - elapsed;
      if (remaining <= 0) {
        break;
      }

      await this.sleep(Math.min(pollIntervalMs, remaining));
    }

    if (lifecycleMarker !== this.lifecycleToken) {
      return this.getStatus();
    }

    await this.terminateChild(
      normalizeTimeout(config.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS),
    );

    if (lifecycleMarker !== this.lifecycleToken) {
      return this.getStatus();
    }

    this.updateStatus({
      state: 'timeout',
      healthy: false,
      pid: null,
      reason: 'startup_timeout',
      checkedAt: this.deps.now(),
    });

    return this.getStatus();
  }

  private startHeartbeat(lifecycleMarker: number, config: SidecarStartConfig) {
    this.stopHeartbeat();

    const heartbeatIntervalMs = normalizeInterval(
      config.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    );

    this.heartbeatTimer = this.deps.setInterval(async () => {
      if (lifecycleMarker !== this.lifecycleToken || this.heartbeatInFlight) {
        return;
      }

      this.heartbeatInFlight = true;
      try {
        const probe = await this.probeHealth(config, 'heartbeat');
        if (lifecycleMarker !== this.lifecycleToken) {
          return;
        }

        if (probe.healthy) {
          this.updateStatus({
            state: 'running',
            healthy: true,
            reason: undefined,
            error: undefined,
            httpStatus: probe.httpStatus,
            checkedAt: probe.checkedAt,
            lastHeartbeatAt: probe.checkedAt,
          });
          return;
        }

        this.updateStatus({
          state: 'unhealthy',
          healthy: false,
          reason:
            probe.reason === 'health_timeout'
              ? 'heartbeat_timeout'
              : 'heartbeat_failed',
          error: probe.error,
          httpStatus: probe.httpStatus,
          checkedAt: probe.checkedAt,
        });
      } finally {
        this.heartbeatInFlight = false;
      }
    }, heartbeatIntervalMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      this.deps.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async probeHealth(
    config: SidecarStartConfig,
    context: HealthProbeContext = 'probe',
  ): Promise<HealthProbeResult> {
    const checkedAt = this.deps.now();

    let targetUrl = '';
    try {
      targetUrl = resolveHealthUrl(config.endpoint, config.healthPath);
    } catch (error) {
      return {
        healthy: false,
        checkedAt,
        reason: 'invalid_endpoint',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const controller = new AbortController();
    const timeoutMs = normalizeTimeout(
      config.healthTimeoutMs,
      DEFAULT_HEALTH_TIMEOUT_MS,
    );

    const timeout = this.deps.setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.deps.fetch(targetUrl, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          healthy: false,
          checkedAt,
          httpStatus: response.status,
          reason: 'health_http_error',
        };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }

      const healthyFromPayload = this.extractHealthFromPayload(payload);
      if (!healthyFromPayload) {
        return {
          healthy: false,
          checkedAt,
          reason: 'health_http_error',
          httpStatus: response.status,
        };
      }

      return {
        healthy: true,
        checkedAt,
        httpStatus: response.status,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          healthy: false,
          checkedAt,
          reason: 'health_timeout',
          error: `Health check timed out in ${timeoutMs}ms`,
        };
      }

      return {
        healthy: false,
        checkedAt,
        reason: context === 'startup' ? 'startup_failed' : 'heartbeat_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.deps.clearTimeout(timeout);
    }
  }

  private extractHealthFromPayload(payload: unknown): boolean {
    return isExplicitHealthyHealthPayload(payload);
  }

  private attachChildListeners(child: ChildProcess, lifecycleMarker: number) {
    child.once('error', (error) => {
      if (lifecycleMarker !== this.lifecycleToken) {
        return;
      }

      emitAgentSTelemetry(
        'agent_s.runtime.error',
        {
          source: 'sidecar.child_error',
          error: error.message,
        },
        { level: 'error', correlation: this.telemetryCorrelation },
      );

      this.updateStatus({
        state: 'unhealthy',
        healthy: false,
        reason: 'startup_failed',
        error: error.message,
        checkedAt: this.deps.now(),
      });
    });

    child.once('exit', (code, signal) => {
      if (lifecycleMarker !== this.lifecycleToken) {
        return;
      }

      emitAgentSTelemetry(
        'agent_s.runtime.error',
        {
          source: 'sidecar.child_exit',
          code,
          signal,
        },
        { level: 'error', correlation: this.telemetryCorrelation },
      );

      this.stopHeartbeat();
      this.child = null;
      this.updateStatus({
        state: this.status.state === 'stopping' ? 'stopped' : 'unhealthy',
        healthy: false,
        pid: null,
        reason:
          this.status.state === 'stopping'
            ? 'stop_requested'
            : 'child_process_exit',
        error:
          code !== null || signal !== null
            ? `sidecar exited (code=${code}, signal=${signal})`
            : undefined,
        checkedAt: this.deps.now(),
      });
    });
  }

  private async terminateChild(shutdownTimeoutMs: number) {
    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;

    if (child.exitCode !== null || child.signalCode !== null || child.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      let resolved = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      let safetyTimer: ReturnType<typeof setTimeout> | null = null;

      const complete = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (forceKillTimer) {
          this.deps.clearTimeout(forceKillTimer);
        }
        if (safetyTimer) {
          this.deps.clearTimeout(safetyTimer);
        }
        resolve();
      };

      const onExit = () => {
        child.removeListener('exit', onExit);
        complete();
      };

      child.once('exit', onExit);

      forceKillTimer = this.deps.setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, shutdownTimeoutMs);

      safetyTimer = this.deps.setTimeout(() => {
        child.removeListener('exit', onExit);
        complete();
      }, shutdownTimeoutMs + 100);

      child.kill('SIGTERM');
    });
  }

  private updateStatus(patch: Partial<SidecarStatus>) {
    const previous = this.status;
    this.status = {
      ...this.status,
      ...patch,
    };

    const hasHealthTransition =
      previous.state !== this.status.state ||
      previous.healthy !== this.status.healthy ||
      previous.reason !== this.status.reason ||
      previous.httpStatus !== this.status.httpStatus;

    if (!hasHealthTransition) {
      return;
    }

    emitAgentSTelemetry(
      'agent_s.sidecar.health',
      {
        state: this.status.state,
        healthy: this.status.healthy,
        mode: this.status.mode,
        endpoint: this.status.endpoint,
        pid: this.status.pid,
        reason: this.status.reason ?? null,
        httpStatus: this.status.httpStatus ?? null,
      },
      {
        level: this.status.healthy ? 'info' : 'warn',
        correlation: this.telemetryCorrelation,
      },
    );

    if (!this.status.healthy && this.status.reason !== 'stop_requested') {
      emitAgentSTelemetry(
        'sidecar_health_degraded',
        {
          state: this.status.state,
          healthy: this.status.healthy,
          mode: this.status.mode,
          endpoint: this.status.endpoint,
          pid: this.status.pid,
          reason: this.status.reason ?? null,
          httpStatus: this.status.httpStatus ?? null,
        },
        {
          level: 'warn',
          correlation: this.telemetryCorrelation,
        },
      );
    }

    if (this.status.healthy) {
      this.lastFallbackEventSignature = null;
      return;
    }

    if (!this.status.reason || this.status.reason === 'stop_requested') {
      return;
    }

    const fallbackSignature = `${this.status.state}:${this.status.reason}:${this.status.httpStatus ?? ''}`;
    if (fallbackSignature === this.lastFallbackEventSignature) {
      return;
    }

    this.lastFallbackEventSignature = fallbackSignature;
    emitAgentSTelemetry(
      'agent_s.fallback.triggered',
      {
        source: 'agent_s.sidecar',
        reasonCode: this.status.reason,
        state: this.status.state,
        endpoint: this.status.endpoint,
        mode: this.status.mode,
      },
      { level: 'warn', correlation: this.telemetryCorrelation },
    );
    emitAgentSTelemetry(
      'engine_fallback_triggered',
      {
        source: 'agent_s.sidecar',
        reasonCode: this.status.reason,
        state: this.status.state,
        endpoint: this.status.endpoint,
        mode: this.status.mode,
      },
      { level: 'warn', correlation: this.telemetryCorrelation },
    );
  }

  private sleep(delayMs: number): Promise<void> {
    if (delayMs <= 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.deps.setTimeout(resolve, delayMs);
    });
  }
}

export const agentSSidecarManager = new AgentSSidecarManager();
