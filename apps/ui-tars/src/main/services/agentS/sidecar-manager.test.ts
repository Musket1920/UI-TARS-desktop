/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/logger', () => ({
  logger: {
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    log: () => undefined,
  },
}));

import { AgentSSidecarManager } from './sidecarManager';

type SpawnFunction = NonNullable<
  NonNullable<ConstructorParameters<typeof AgentSSidecarManager>[0]>['spawn']
>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

const createHealthyResponse = (payload: unknown = { healthy: true }) =>
  ({
    ok: true,
    status: 200,
    json: async () => payload,
  }) as Response;

const withHalfOpenProbeConfig = async (callback: () => Promise<void>) => {
  const originalThreshold =
    process.env.AGENT_S_CIRCUIT_BREAKER_FAILURE_THRESHOLD;
  const originalCooldown = process.env.AGENT_S_CIRCUIT_BREAKER_COOLDOWN_MS;

  process.env.AGENT_S_CIRCUIT_BREAKER_FAILURE_THRESHOLD = '1';
  process.env.AGENT_S_CIRCUIT_BREAKER_COOLDOWN_MS = '0';

  try {
    await callback();
  } finally {
    if (typeof originalThreshold === 'undefined') {
      delete process.env.AGENT_S_CIRCUIT_BREAKER_FAILURE_THRESHOLD;
    } else {
      process.env.AGENT_S_CIRCUIT_BREAKER_FAILURE_THRESHOLD = originalThreshold;
    }

    if (typeof originalCooldown === 'undefined') {
      delete process.env.AGENT_S_CIRCUIT_BREAKER_COOLDOWN_MS;
    } else {
      process.env.AGENT_S_CIRCUIT_BREAKER_COOLDOWN_MS = originalCooldown;
    }
  }
};

class MockChildProcess extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(pid = 1001) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;

    if (signal === 'SIGKILL') {
      this.signalCode = 'SIGKILL';
    } else {
      this.signalCode = 'SIGTERM';
    }

    this.emit('exit', this.exitCode, this.signalCode);
    return true;
  }
}

describe('sidecar-manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts embedded sidecar and reports running when startup health succeeds', async () => {
    const child = new MockChildProcess(4321);
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true }),
    } as Response);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const startPromise = manager.start({
      mode: 'embedded',
      command: 'python',
      args: ['-m', 'agent_s', '--api_key', 'secret-value'],
      endpoint: 'http://127.0.0.1:9000',
      startupTimeoutMs: 2_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 500,
      healthTimeoutMs: 300,
    });

    const status = await startPromise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalled();
    expect(status.state).toBe('running');
    expect(status.healthy).toBe(true);
    expect(status.mode).toBe('embedded');
    expect(status.pid).toBe(4321);
    expect(status.reason).toBeUndefined();
  });

  it('allows path-qualified python embedded launcher through the allowlist', async () => {
    const child = new MockChildProcess(5555);
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true }),
    } as Response);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const status = await manager.start({
      mode: 'embedded',
      command: './venv/bin/python',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9700',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 500,
      healthTimeoutMs: 300,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(status.state).toBe('running');
    expect(status.mode).toBe('embedded');
    expect(status.pid).toBe(5555);
    expect(status.healthy).toBe(true);
    expect(status.reason).toBeUndefined();
  });

  it('still requires path-qualified python launchers to use -m agent_s', async () => {
    const spawnMock = vi.fn<SpawnFunction>();
    const fetchMock = vi.fn<typeof fetch>();

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const status = await manager.start({
      mode: 'embedded',
      command: './venv/bin/python3',
      args: ['agent_s'],
      endpoint: 'http://127.0.0.1:9701',
      startupTimeoutMs: 500,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 500,
      healthTimeoutMs: 300,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status.state).toBe('unhealthy');
    expect(status.healthy).toBe(false);
    expect(status.reason).toBe('startup_failed');
    expect(status.error).toBe(
      'Embedded Python sidecar command must launch agent_s via -m agent_s',
    );
  });

  it('rejects path-qualified embedded launchers outside the allowlist', async () => {
    const spawnMock = vi.fn<SpawnFunction>();
    const fetchMock = vi.fn<typeof fetch>();

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const status = await manager.start({
      mode: 'embedded',
      command: '/usr/local/bin/bash',
      args: ['-c', 'echo', 'blocked'],
      endpoint: 'http://127.0.0.1:9800',
      startupTimeoutMs: 500,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 500,
      healthTimeoutMs: 300,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status.state).toBe('unhealthy');
    expect(status.healthy).toBe(false);
    expect(status.reason).toBe('startup_failed');
  });

  it('returns timeout state when startup never becomes healthy', async () => {
    const child = new MockChildProcess(3200);
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ status: 'down' }),
    } as Response);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const startPromise = manager.start({
      mode: 'embedded',
      command: 'python',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9100',
      startupTimeoutMs: 600,
      startupPollIntervalMs: 100,
      shutdownTimeoutMs: 200,
      healthTimeoutMs: 200,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    const status = await startPromise;

    expect(status.state).toBe('timeout');
    expect(status.healthy).toBe(false);
    expect(status.reason).toBe('startup_timeout');
    expect(status.pid).toBeNull();
    expect(child.killed).toBe(true);
  });

  it('labels startup fetch failures as startup_failed before timing out', async () => {
    const child = new MockChildProcess(3300);
    const startupProbe = createDeferred<Response>();
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => startupProbe.promise)
      .mockRejectedValue(new Error('connect ECONNREFUSED'));

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const startPromise = manager.start({
      mode: 'embedded',
      command: 'python',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9150',
      startupTimeoutMs: 600,
      startupPollIntervalMs: 100,
      shutdownTimeoutMs: 200,
      healthTimeoutMs: 200,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    startupProbe.reject(new Error('connect ECONNREFUSED'));

    await vi.advanceTimersByTimeAsync(0);

    const startupStatus = manager.getStatus();
    expect(startupStatus.state).toBe('starting');
    expect(startupStatus.healthy).toBe(false);
    expect(startupStatus.reason).toBe('startup_failed');
    expect(startupStatus.reason).not.toBe('heartbeat_failed');
    expect(startupStatus.error).toContain('connect ECONNREFUSED');

    await vi.advanceTimersByTimeAsync(2_000);
    const finalStatus = await startPromise;

    expect(finalStatus.state).toBe('timeout');
    expect(finalStatus.reason).toBe('startup_timeout');
    expect(child.killed).toBe(true);
  });

  it('marks running sidecar unhealthy when heartbeat check fails', async () => {
    const child = new MockChildProcess(4500);
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ status: 'error' }),
      } as Response);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const startStatus = await manager.start({
      mode: 'embedded',
      command: 'python',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9200',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 300,
      healthTimeoutMs: 300,
    });

    expect(startStatus.state).toBe('running');

    await vi.advanceTimersByTimeAsync(400);
    await vi.runOnlyPendingTimersAsync();

    const status = manager.getStatus();
    expect(status.state).toBe('unhealthy');
    expect(status.healthy).toBe(false);
    expect(status.reason).toBe('heartbeat_failed');
  });

  it('stops embedded child and clears process state', async () => {
    const child = new MockChildProcess(7777);
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true }),
    } as Response);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    await manager.start({
      mode: 'embedded',
      command: 'python',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9300',
      startupTimeoutMs: 1_000,
      heartbeatIntervalMs: 300,
    });

    const stopped = await manager.stop();

    expect(child.killed).toBe(true);
    expect(stopped.state).toBe('stopped');
    expect(stopped.healthy).toBe(false);
    expect(stopped.pid).toBeNull();
    expect(stopped.reason).toBe('stop_requested');
  });

  it('uses external endpoint mode without spawning process and still reports health', async () => {
    const spawnMock = vi.fn();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'healthy' }),
    } as Response);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock as SpawnFunction,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const status = await manager.start({
      mode: 'external',
      endpoint: 'https://agent-s.local',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 500,
      healthTimeoutMs: 300,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(status.state).toBe('running');
    expect(status.mode).toBe('external');
    expect(status.pid).toBeNull();
    expect(status.healthy).toBe(true);

    const probed = await manager.health({ probe: true });
    expect(probed.state).toBe('running');
    expect(probed.healthy).toBe(true);
  });

  it('returns an unhealthy probe result without downgrading stored healthy status on a transient failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createHealthyResponse())
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ status: 'down' }),
      } as Response)
      .mockResolvedValueOnce(createHealthyResponse());

    const manager = new AgentSSidecarManager({
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const started = await manager.start({
      mode: 'external',
      endpoint: 'https://agent-s.local',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 5_000,
      healthTimeoutMs: 300,
    });

    expect(started.state).toBe('running');
    expect(started.healthy).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    const failedProbe = await manager.health({ probe: true });

    expect(failedProbe.state).toBe('unhealthy');
    expect(failedProbe.healthy).toBe(false);
    expect(failedProbe.reason).toBe('health_http_error');

    const storedAfterFailedProbe = manager.getStatus();
    expect(storedAfterFailedProbe.state).toBe('running');
    expect(storedAfterFailedProbe.healthy).toBe(true);
    expect(storedAfterFailedProbe.reason).toBeUndefined();
    expect(storedAfterFailedProbe.checkedAt).toBe(started.checkedAt);
    expect(storedAfterFailedProbe.lastHeartbeatAt).toBe(started.checkedAt);

    await vi.advanceTimersByTimeAsync(1_000);
    const recoveredProbe = await manager.health({ probe: true });

    expect(recoveredProbe.state).toBe('running');
    expect(recoveredProbe.healthy).toBe(true);
    expect(recoveredProbe.checkedAt).toBeGreaterThan(started.checkedAt);

    const storedAfterRecoveredProbe = manager.getStatus();
    expect(storedAfterRecoveredProbe.state).toBe('running');
    expect(storedAfterRecoveredProbe.healthy).toBe(true);
    expect(storedAfterRecoveredProbe.checkedAt).toBe(recoveredProbe.checkedAt);
    expect(storedAfterRecoveredProbe.lastHeartbeatAt).toBe(
      recoveredProbe.checkedAt,
    );
  });

  it('maps explicit live probe connection failures to health_probe_failed', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createHealthyResponse())
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const manager = new AgentSSidecarManager({
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const started = await manager.start({
      mode: 'external',
      endpoint: 'https://agent-s.local',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 5_000,
      healthTimeoutMs: 300,
    });

    expect(started.state).toBe('running');
    expect(started.healthy).toBe(true);

    const failedProbe = await manager.health({ probe: true });

    expect(failedProbe.state).toBe('unhealthy');
    expect(failedProbe.healthy).toBe(false);
    expect(failedProbe.reason).toBe('health_probe_failed');
    expect(failedProbe.reason).not.toBe('heartbeat_failed');
    expect(failedProbe.error).toContain('connect ECONNREFUSED');

    const storedStatus = manager.getStatus();
    expect(storedStatus.state).toBe('running');
    expect(storedStatus.healthy).toBe(true);
    expect(storedStatus.reason).toBeUndefined();
  });

  it('normalizes trailing /health endpoints and still honors explicit custom health paths', async () => {
    const defaultFetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(createHealthyResponse());
    const trailingSlashFetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(createHealthyResponse());
    const customFetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(createHealthyResponse());

    const defaultManager = new AgentSSidecarManager({
      spawn: vi.fn() as SpawnFunction,
      fetch: defaultFetchMock,
      now: () => Date.now(),
    });
    const trailingSlashManager = new AgentSSidecarManager({
      spawn: vi.fn() as SpawnFunction,
      fetch: trailingSlashFetchMock,
      now: () => Date.now(),
    });
    const customManager = new AgentSSidecarManager({
      spawn: vi.fn() as SpawnFunction,
      fetch: customFetchMock,
      now: () => Date.now(),
    });

    await defaultManager.start({
      mode: 'external',
      endpoint: 'http://127.0.0.1:9800/health',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 500,
      healthTimeoutMs: 300,
    });
    await trailingSlashManager.start({
      mode: 'external',
      endpoint: 'http://127.0.0.1:9802/health/',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 500,
      healthTimeoutMs: 300,
    });
    await customManager.start({
      mode: 'external',
      endpoint: 'http://127.0.0.1:9801/health/',
      healthPath: '/readyz',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 500,
      healthTimeoutMs: 300,
    });

    expect(defaultFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9800/health',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(trailingSlashFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9802/health',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(customFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9801/readyz',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('restart clears old child reference and starts a new process', async () => {
    const firstChild = new MockChildProcess(1111);
    const secondChild = new MockChildProcess(2222);
    const spawnMock = vi
      .fn<SpawnFunction>()
      .mockReturnValueOnce(firstChild as unknown as ReturnType<SpawnFunction>)
      .mockReturnValueOnce(secondChild as unknown as ReturnType<SpawnFunction>);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true }),
    } as Response);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    await manager.start({
      mode: 'embedded',
      command: 'python',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9400',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
      healthTimeoutMs: 300,
    });

    const restarted = await manager.restart({
      mode: 'embedded',
      command: 'python3',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9401',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
      healthTimeoutMs: 300,
    });

    expect(firstChild.killed).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(restarted.state).toBe('running');
    expect(restarted.pid).toBe(2222);
    expect(restarted.endpoint).toBe('http://127.0.0.1:9401');
  });

  it('deduplicates concurrent start calls while startup is already in flight', async () => {
    const child = new MockChildProcess(7003);
    const startupProbe = createDeferred<Response>();
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => startupProbe.promise);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const config = {
      mode: 'embedded' as const,
      command: 'python',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9702',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
      healthTimeoutMs: 300,
    };

    const firstStart = manager.start(config);
    const secondStart = manager.start(config);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(child.killed).toBe(false);

    startupProbe.resolve(createHealthyResponse());

    const [firstStatus, secondStatus] = await Promise.all([
      firstStart,
      secondStart,
    ]);

    expect(firstStatus.state).toBe('running');
    expect(secondStatus.state).toBe('running');
    expect(secondStatus.endpoint).toBe('http://127.0.0.1:9702');
    expect(secondStatus.pid).toBe(7003);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stop during startup followed by new start does not reuse stale startup result', async () => {
    const firstChild = new MockChildProcess(7101);
    const secondChild = new MockChildProcess(7102);
    const firstProbe = createDeferred<Response>();
    const spawnMock = vi
      .fn<SpawnFunction>()
      .mockReturnValueOnce(firstChild as unknown as ReturnType<SpawnFunction>)
      .mockReturnValueOnce(secondChild as unknown as ReturnType<SpawnFunction>);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstProbe.promise)
      .mockResolvedValueOnce(createHealthyResponse());

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const firstStart = manager.start({
      mode: 'embedded',
      command: 'python',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9710',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
      healthTimeoutMs: 300,
    });

    const stopped = await manager.stop();
    expect(stopped.state).toBe('stopped');
    expect(stopped.reason).toBe('stop_requested');
    expect(firstChild.killed).toBe(true);
    expect(
      (
        manager as unknown as {
          startPromise: Promise<unknown> | null;
          startPromiseToken: number | null;
        }
      ).startPromise,
    ).toBeNull();
    expect(
      (
        manager as unknown as {
          startPromise: Promise<unknown> | null;
          startPromiseToken: number | null;
        }
      ).startPromiseToken,
    ).toBeNull();

    const restarted = await manager.start({
      mode: 'embedded',
      command: 'python3',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9711',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
      healthTimeoutMs: 300,
    });

    expect(restarted.state).toBe('running');
    expect(restarted.endpoint).toBe('http://127.0.0.1:9711');
    expect(restarted.pid).toBe(7102);

    firstProbe.resolve(createHealthyResponse());
    const staleStatus = await firstStart;

    expect(staleStatus.state).toBe('running');
    expect(staleStatus.endpoint).toBe('http://127.0.0.1:9711');
    expect(manager.getStatus().endpoint).toBe('http://127.0.0.1:9711');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the in-flight config for status and health probes when start is deduplicated', async () => {
    const child = new MockChildProcess(7201);
    const startupProbe = createDeferred<Response>();
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => startupProbe.promise)
      .mockResolvedValueOnce(createHealthyResponse({ status: 'running' }));

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const firstStart = manager.start({
      mode: 'embedded',
      command: 'python',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9720',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
      healthTimeoutMs: 300,
    });

    const secondStart = manager.start({
      mode: 'embedded',
      command: 'python3',
      args: ['-m', 'agent_s', '--port', '10801'],
      endpoint: 'http://127.0.0.1:9721/base',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
      healthTimeoutMs: 300,
    });

    startupProbe.resolve(createHealthyResponse());

    const [firstStatus, secondStatus] = await Promise.all([
      firstStart,
      secondStart,
    ]);
    const probed = await manager.health({ probe: true });

    expect(firstStatus.endpoint).toBe('http://127.0.0.1:9720');
    expect(secondStatus.endpoint).toBe('http://127.0.0.1:9720');
    expect(probed.endpoint).toBe('http://127.0.0.1:9720');
    expect(probed.pid).toBe(7201);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:9720/health',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:9720/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('re-opens the breaker when a half-open recovery probe fails, even if stored status stays healthy', async () => {
    await withHalfOpenProbeConfig(async () => {
      const halfOpenProbe = createDeferred<Response>();
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(createHealthyResponse())
        .mockImplementationOnce(() => halfOpenProbe.promise);

      const manager = new AgentSSidecarManager({
        fetch: fetchMock,
        now: () => Date.now(),
      });

      const started = await manager.start({
        mode: 'external',
        endpoint: 'https://agent-s.local',
        startupTimeoutMs: 1_000,
        startupPollIntervalMs: 100,
        heartbeatIntervalMs: 5_000,
        healthTimeoutMs: 300,
      });

      manager.recordCircuitFailure({
        source: 'runtime',
        reasonCode: 'AGENT_S_TURN_REQUEST_FAILED',
      });

      await vi.advanceTimersByTimeAsync(50);

      const failureSpy = vi.spyOn(manager, 'recordCircuitFailure');
      const successSpy = vi.spyOn(manager, 'recordCircuitSuccess');

      const firstDecisionPromise = manager.evaluateDispatchCircuit();
      const secondDecisionPromise = manager.evaluateDispatchCircuit();

      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(failureSpy).not.toHaveBeenCalled();
      expect(successSpy).not.toHaveBeenCalled();

      halfOpenProbe.resolve({
        ok: false,
        status: 503,
        json: async () => ({ status: 'down' }),
      } as Response);

      const [firstDecision, secondDecision] = await Promise.all([
        firstDecisionPromise,
        secondDecisionPromise,
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(failureSpy).toHaveBeenCalledTimes(1);
      expect(failureSpy).toHaveBeenCalledWith({
        source: 'probe',
        reasonCode: 'health_http_error',
      });
      expect(successSpy).not.toHaveBeenCalled();
      expect(firstDecision.allowAgentS).toBe(false);
      expect(firstDecision.reasonCode).toBe('circuit_breaker_open');
      expect(firstDecision.breaker.state).toBe('open');
      expect(firstDecision.sidecarStatus?.state).toBe('unhealthy');
      expect(firstDecision.sidecarStatus?.healthy).toBe(false);
      expect(firstDecision.sidecarStatus?.reason).toBe('health_http_error');
      expect(secondDecision.allowAgentS).toBe(false);
      expect(secondDecision.reasonCode).toBe('circuit_breaker_open');
      expect(secondDecision.breaker.state).toBe('open');
      expect(firstDecision.sidecarStatus?.checkedAt).toBe(
        secondDecision.sidecarStatus?.checkedAt,
      );

      const storedStatus = manager.getStatus();
      expect(storedStatus.state).toBe('running');
      expect(storedStatus.healthy).toBe(true);
      expect(storedStatus.reason).toBeUndefined();
      expect(storedStatus.checkedAt).toBe(started.checkedAt);
      expect(manager.getCircuitBreakerStatus().state).toBe('open');
    });
  });

  it('deduplicates concurrent half-open probe recovery', async () => {
    await withHalfOpenProbeConfig(async () => {
      const halfOpenProbe = createDeferred<Response>();
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(createHealthyResponse())
        .mockImplementationOnce(() => halfOpenProbe.promise);

      const manager = new AgentSSidecarManager({
        fetch: fetchMock,
        now: () => Date.now(),
      });

      await manager.start({
        mode: 'external',
        endpoint: 'https://agent-s.local',
        startupTimeoutMs: 1_000,
        startupPollIntervalMs: 100,
        heartbeatIntervalMs: 5_000,
        healthTimeoutMs: 300,
      });

      manager.recordCircuitFailure({
        source: 'runtime',
        reasonCode: 'AGENT_S_TURN_REQUEST_FAILED',
      });

      await vi.advanceTimersByTimeAsync(50);

      const failureSpy = vi.spyOn(manager, 'recordCircuitFailure');
      const successSpy = vi.spyOn(manager, 'recordCircuitSuccess');

      const firstDecisionPromise = manager.evaluateDispatchCircuit();
      const secondDecisionPromise = manager.evaluateDispatchCircuit();

      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(failureSpy).not.toHaveBeenCalled();
      expect(successSpy).not.toHaveBeenCalled();

      halfOpenProbe.resolve(createHealthyResponse());

      const [firstDecision, secondDecision] = await Promise.all([
        firstDecisionPromise,
        secondDecisionPromise,
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(failureSpy).not.toHaveBeenCalled();
      expect(successSpy).toHaveBeenCalledTimes(1);
      expect(firstDecision.allowAgentS).toBe(true);
      expect(firstDecision.reasonCode).toBe('circuit_breaker_recovered');
      expect(firstDecision.breaker.state).toBe('closed');
      expect(secondDecision.allowAgentS).toBe(true);
      expect(secondDecision.reasonCode).toBe('circuit_breaker_recovered');
      expect(secondDecision.breaker.state).toBe('closed');
      expect(firstDecision.sidecarStatus?.checkedAt).toBe(
        secondDecision.sidecarStatus?.checkedAt,
      );
    });
  });

  it('stop invalidates a stale half-open probe before the next lifecycle', async () => {
    await withHalfOpenProbeConfig(async () => {
      const staleHalfOpenProbe = createDeferred<Response>();
      const freshHalfOpenProbe = createDeferred<Response>();
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(createHealthyResponse())
        .mockImplementationOnce(() => staleHalfOpenProbe.promise)
        .mockResolvedValueOnce(createHealthyResponse())
        .mockImplementationOnce(() => freshHalfOpenProbe.promise);

      const manager = new AgentSSidecarManager({
        fetch: fetchMock,
        now: () => Date.now(),
      });

      await manager.start({
        mode: 'external',
        endpoint: 'https://agent-s.local',
        startupTimeoutMs: 1_000,
        startupPollIntervalMs: 100,
        heartbeatIntervalMs: 5_000,
        healthTimeoutMs: 300,
      });

      manager.recordCircuitFailure({
        source: 'runtime',
        reasonCode: 'AGENT_S_TURN_REQUEST_FAILED',
      });

      await vi.advanceTimersByTimeAsync(50);

      const successSpy = vi.spyOn(manager, 'recordCircuitSuccess');
      const failureSpy = vi.spyOn(manager, 'recordCircuitFailure');

      const staleDecisionPromise = manager.evaluateDispatchCircuit();

      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(2);

      const stopped = await manager.stop();

      expect(stopped.state).toBe('stopped');
      expect(stopped.reason).toBe('stop_requested');
      expect(manager.getCircuitBreakerStatus().state).toBe('open');

      const restarted = await manager.start({
        mode: 'external',
        endpoint: 'https://agent-s-next.local',
        startupTimeoutMs: 1_000,
        startupPollIntervalMs: 100,
        heartbeatIntervalMs: 5_000,
        healthTimeoutMs: 300,
      });

      expect(restarted.state).toBe('running');
      expect(restarted.endpoint).toBe('https://agent-s-next.local');

      const freshDecisionPromise = manager.evaluateDispatchCircuit();

      await vi.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(successSpy).not.toHaveBeenCalled();
      expect(failureSpy).not.toHaveBeenCalled();

      staleHalfOpenProbe.resolve(createHealthyResponse());
      const staleDecision = await staleDecisionPromise;

      expect(staleDecision.allowAgentS).toBe(false);
      expect(staleDecision.reasonCode).toBe('circuit_breaker_open');
      expect(successSpy).not.toHaveBeenCalled();
      expect(failureSpy).not.toHaveBeenCalled();
      expect(manager.getCircuitBreakerStatus().state).toBe('half_open');

      freshHalfOpenProbe.resolve(createHealthyResponse());
      const freshDecision = await freshDecisionPromise;

      expect(freshDecision.allowAgentS).toBe(true);
      expect(freshDecision.reasonCode).toBe('circuit_breaker_recovered');
      expect(freshDecision.breaker.state).toBe('closed');
      expect(successSpy).toHaveBeenCalledTimes(1);
      expect(failureSpy).not.toHaveBeenCalled();
      expect(manager.getCircuitBreakerStatus().state).toBe('closed');
    });
  });

  it('strips --enable_local_env from embedded sidecar args before spawn', async () => {
    const child = new MockChildProcess(9999);
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true }),
    } as Response);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    await manager.start({
      mode: 'embedded',
      command: 'agent_s',
      args: [
        '--port',
        '10800',
        '--enable_local_env',
        '--enable_local_env=true',
      ],
      endpoint: 'http://127.0.0.1:9500',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 500,
      healthTimeoutMs: 300,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const firstSpawnCall = spawnMock.mock.calls[0];
    expect(firstSpawnCall).toBeDefined();

    const [command, spawnedArgs, options] = firstSpawnCall!;
    expect(command).toBe('agent_s');
    expect(spawnedArgs).toEqual(['--port', '10800']);
    expect(options).toMatchObject({ windowsHide: true });
  });

  it('allows direct agent_s launcher in embedded mode', async () => {
    const child = new MockChildProcess(10001);
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true }),
    } as Response);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const status = await manager.start({
      mode: 'embedded',
      command: 'agent_s',
      args: ['--port', '10800'],
      endpoint: 'http://127.0.0.1:9510',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 500,
      healthTimeoutMs: 300,
    });

    expect(status.state).toBe('running');
    expect(status.healthy).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnCall = spawnMock.mock.calls[0];
    expect(spawnCall).toBeDefined();

    const [command, args] = spawnCall!;
    expect(command).toBe('agent_s');
    expect(args).toEqual(['--port', '10800']);
  });

  it.each([
    {
      name: 'python -m agent_s',
      command: 'python',
      args: ['-m', 'agent_s', '--port', '10800'],
    },
    {
      name: 'python3 -m agent_s',
      command: 'python3',
      args: ['-m', 'agent_s', '--port', '10801'],
    },
  ])('allows embedded launcher %s', async ({ command, args }) => {
    const child = new MockChildProcess(10002);
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true }),
    } as Response);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const status = await manager.start({
      mode: 'embedded',
      command,
      args,
      endpoint: 'http://127.0.0.1:9511',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 500,
      healthTimeoutMs: 300,
    });

    expect(status.state).toBe('running');
    expect(status.healthy).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnCall = spawnMock.mock.calls[0];
    expect(spawnCall).toBeDefined();

    const [spawnedCommand, spawnedArgs] = spawnCall!;
    expect(spawnedCommand).toBe(command);
    expect(spawnedArgs).toEqual(args);
  });

  it.each([
    {
      name: 'bash binary',
      command: 'bash',
      args: ['-lc', 'agent_s'],
    },
    {
      name: 'cmd binary',
      command: 'cmd',
      args: ['/c', 'agent_s'],
    },
    {
      name: 'python without -m agent_s',
      command: 'python',
      args: ['script.py'],
    },
    {
      name: 'python with different module',
      command: 'python3',
      args: ['-m', 'pip'],
    },
    {
      name: 'path-based denied launcher',
      command: './launcher',
      args: [],
    },
  ])(
    'fails closed before spawn for denied embedded launcher: %s',
    async ({ command, args }) => {
      const spawnMock = vi.fn<SpawnFunction>();
      const fetchMock = vi.fn<typeof fetch>();

      const manager = new AgentSSidecarManager({
        spawn: spawnMock as SpawnFunction,
        fetch: fetchMock,
        now: () => Date.now(),
      });

      const status = await manager.start({
        mode: 'embedded',
        command,
        args,
        endpoint: 'http://127.0.0.1:9512',
        startupTimeoutMs: 1_000,
        startupPollIntervalMs: 100,
        heartbeatIntervalMs: 500,
        healthTimeoutMs: 300,
      });

      expect(status.state).toBe('unhealthy');
      expect(status.healthy).toBe(false);
      expect(status.reason).toBe('startup_failed');
      expect(status.pid).toBeNull();
      expect(status.error).toContain('agent_s');
      expect(spawnMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('treats explicit healthy payload marker as healthy', async () => {
    const child = new MockChildProcess(1234);
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true }),
    } as Response);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const status = await manager.start({
      mode: 'embedded',
      command: 'python',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9600',
      startupTimeoutMs: 800,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 500,
      healthTimeoutMs: 300,
    });

    expect(status.state).toBe('running');
    expect(status.healthy).toBe(true);
  });

  it('treats explicit unhealthy payload marker as unhealthy and times out startup', async () => {
    const child = new MockChildProcess(1235);
    const spawnMock = vi.fn<SpawnFunction>(
      () => child as unknown as ReturnType<SpawnFunction>,
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ healthy: false }),
    } as Response);

    const manager = new AgentSSidecarManager({
      spawn: spawnMock,
      fetch: fetchMock,
      now: () => Date.now(),
    });

    const startPromise = manager.start({
      mode: 'embedded',
      command: 'python',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9601',
      startupTimeoutMs: 600,
      startupPollIntervalMs: 100,
      healthTimeoutMs: 300,
      shutdownTimeoutMs: 200,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    const status = await startPromise;

    expect(status.state).toBe('timeout');
    expect(status.healthy).toBe(false);
    expect(status.reason).toBe('startup_timeout');
  });

  it('fails closed for malformed or ambiguous health payloads', async () => {
    const manager = new AgentSSidecarManager();
    const extractHealthFromPayload = (
      manager as unknown as {
        extractHealthFromPayload: (payload: unknown) => boolean;
      }
    ).extractHealthFromPayload;

    expect(extractHealthFromPayload(undefined)).toBe(false);
    expect(extractHealthFromPayload({})).toBe(false);
    expect(extractHealthFromPayload({ healthy: 'true' })).toBe(false);
    expect(extractHealthFromPayload({ status: 'unknown' })).toBe(false);
  });

  it('accepts explicit schema-driven healthy status markers', async () => {
    const manager = new AgentSSidecarManager();
    const extractHealthFromPayload = (
      manager as unknown as {
        extractHealthFromPayload: (payload: unknown) => boolean;
      }
    ).extractHealthFromPayload;

    expect(extractHealthFromPayload({ healthy: true })).toBe(true);
    expect(extractHealthFromPayload({ status: 'UP' })).toBe(true);
    expect(extractHealthFromPayload({ healthy: true, status: 'ok' })).toBe(
      true,
    );
  });

  it('rejects ambiguous health payloads that do not match strict schema', async () => {
    const manager = new AgentSSidecarManager();
    const extractHealthFromPayload = (
      manager as unknown as {
        extractHealthFromPayload: (payload: unknown) => boolean;
      }
    ).extractHealthFromPayload;

    expect(extractHealthFromPayload({ healthy: true, status: 'unknown' })).toBe(
      false,
    );
    expect(extractHealthFromPayload({ status: 'running' })).toBe(false);
    expect(
      extractHealthFromPayload({ healthy: false, status: 'running' }),
    ).toBe(false);
    expect(extractHealthFromPayload({ status: '' })).toBe(false);
    expect(extractHealthFromPayload({ status: ['running'] })).toBe(false);
  });
});
