import { EventEmitter } from 'node:events';

import type { SidecarFailureReason, SidecarStatus } from './sidecarManager';

export type SidecarFixtureMode = 'ok' | 'timeout' | 'malformed' | 'crash';

export type SidecarHealthPayload = Record<string, unknown>;

const BASE_ENDPOINT = 'http://127.0.0.1:10800';

export const deterministicFixtureHealthPayloads: Record<
  SidecarFixtureMode,
  SidecarHealthPayload
> = {
  ok: {
    status: 'running',
    healthy: true,
    message: 'fixture-ok ready',
  },
  timeout: {
    status: 'timeout',
    healthy: false,
    message: 'startup timed out before health check',
  },
  malformed: {
    status: 'broken',
    healthy: false,
    message: 'malformed payload',
  },
  crash: {
    status: 'crashed',
    healthy: false,
    message: 'sidecar crash simulated by fixture',
  },
};

interface FixtureFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

class FakeSidecarProcess extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
    this.emit('exit', this.exitCode, this.signalCode);
    return true;
  }

  crash(reason: NodeJS.Signals = 'SIGKILL') {
    this.exitCode = 1;
    this.signalCode = reason;
    this.emit('exit', this.exitCode, this.signalCode);
  }
}

const statusTemplates: Record<SidecarFixtureMode, SidecarStatus> = {
  ok: {
    state: 'running',
    mode: 'embedded',
    healthy: true,
    endpoint: BASE_ENDPOINT,
    pid: 4301,
    checkedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    httpStatus: 200,
  },
  timeout: {
    state: 'timeout',
    mode: 'embedded',
    healthy: false,
    endpoint: BASE_ENDPOINT,
    pid: null,
    checkedAt: Date.now(),
    lastHeartbeatAt: null,
    reason: 'startup_timeout',
    error: 'Fixture forced startup timeout',
  },
  malformed: {
    state: 'unhealthy',
    mode: 'embedded',
    healthy: false,
    endpoint: BASE_ENDPOINT,
    pid: 4310,
    checkedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    httpStatus: 502,
    reason: 'health_http_error',
    error: 'Fixture returned malformed payload',
  },
  crash: {
    state: 'unhealthy',
    mode: 'embedded',
    healthy: false,
    endpoint: BASE_ENDPOINT,
    pid: 4322,
    checkedAt: Date.now(),
    lastHeartbeatAt: null,
    reason: 'child_process_exit',
    error: 'Fixture simulated sidecar crash',
  },
};

const createFetchForMode = (mode: SidecarFixtureMode) => async () => {
  switch (mode) {
    case 'ok':
      return {
        ok: true,
        status: 200,
        json: async () => deterministicFixtureHealthPayloads.ok,
      } satisfies FixtureFetchResponse;
    case 'timeout':
      throw new Error('Fixture timeout: sidecar did not respond in time');
    case 'malformed':
      return {
        ok: false,
        status: 502,
        json: async () => deterministicFixtureHealthPayloads.malformed,
      } satisfies FixtureFetchResponse;
    case 'crash':
      throw new Error('Fixture crash: sidecar terminated before health event');
  }
};

const buildStatus = (mode: SidecarFixtureMode): SidecarStatus => ({
  ...statusTemplates[mode],
  checkedAt: Date.now(),
  lastHeartbeatAt:
    statusTemplates[mode].lastHeartbeatAt === null ? null : Date.now(),
});

const createStoppedStatus = (): SidecarStatus => ({
  state: 'stopped',
  mode: null,
  healthy: false,
  endpoint: BASE_ENDPOINT,
  pid: null,
  checkedAt: Date.now(),
  lastHeartbeatAt: null,
  reason: 'stop_requested',
});

export interface SidecarFixture {
  mode: SidecarFixtureMode;
  endpoint: string;
  fetch: () => Promise<FixtureFetchResponse>;
  spawn: () => FakeSidecarProcess;
  status: SidecarStatus;
  payload: SidecarHealthPayload;
}

export const createSidecarFixture = (
  mode: SidecarFixtureMode,
): SidecarFixture => ({
  mode,
  endpoint: BASE_ENDPOINT,
  fetch: createFetchForMode(mode),
  spawn: () => new FakeSidecarProcess(statusTemplates[mode].pid ?? 4500),
  status: buildStatus(mode),
  payload: deterministicFixtureHealthPayloads[mode],
});

export interface RuntimeSidecarHarness {
  fixtureMode: SidecarFixtureMode;
  start: () => Promise<SidecarStatus>;
  stop: () => Promise<SidecarStatus>;
  health: (options?: { probe?: boolean }) => Promise<SidecarStatus>;
  getStatus: () => SidecarStatus;
  setTelemetryCorrelation: (correlation: Record<string, string | null>) => void;
}

const createFailureStatus = (
  reason: SidecarFailureReason,
  overrides?: Partial<SidecarStatus>,
): SidecarStatus => ({
  state: reason === 'startup_timeout' ? 'timeout' : 'unhealthy',
  mode: overrides?.mode ?? 'embedded',
  healthy: false,
  endpoint: BASE_ENDPOINT,
  pid: overrides?.pid ?? null,
  checkedAt: Date.now(),
  lastHeartbeatAt: overrides?.lastHeartbeatAt ?? null,
  reason,
  ...overrides,
});

export const createRuntimeSidecarHarness = (
  mode: SidecarFixtureMode,
  overrides: Partial<SidecarStatus> = {},
): RuntimeSidecarHarness => {
  const baseStatus = buildStatus(mode);
  const statusWithOverrides = { ...baseStatus, ...overrides };
  let currentStatus: SidecarStatus = createStoppedStatus();

  const createModeHealthStatus = (): SidecarStatus => {
    if (mode === 'timeout') {
      return {
        ...createFailureStatus('startup_timeout', overrides),
        state: 'timeout',
        healthy: false,
        reason: 'startup_timeout' as const,
        transientProbeFailure: undefined,
      };
    }
    if (mode === 'malformed') {
      return {
        ...createFailureStatus('health_http_error', overrides),
        state: 'unhealthy',
        healthy: false,
        reason: 'health_http_error' as const,
        transientProbeFailure: undefined,
      };
    }
    if (mode === 'crash') {
      return {
        ...createFailureStatus('child_process_exit', overrides),
        state: 'unhealthy',
        healthy: false,
        reason: 'child_process_exit' as const,
        transientProbeFailure: undefined,
      };
    }

    return statusWithOverrides;
  };

  return {
    fixtureMode: mode,
    start: async () => {
      if (mode === 'crash') {
        throw new Error('Sidecar simulated crash during startup');
      }
      currentStatus = statusWithOverrides;
      return currentStatus;
    },
    health: async (options = {}) => {
      const nextStatus = createModeHealthStatus();

      if (
        options.probe &&
        !nextStatus.healthy &&
        currentStatus.state === 'running' &&
        currentStatus.healthy
      ) {
        currentStatus = {
          ...nextStatus,
          transientProbeFailure: true,
        };
        return currentStatus;
      }

      currentStatus = nextStatus;
      return currentStatus;
    },
    stop: async () => {
      currentStatus = createStoppedStatus();
      return currentStatus;
    },
    getStatus: () => currentStatus,
    setTelemetryCorrelation: () => undefined,
  };
};
