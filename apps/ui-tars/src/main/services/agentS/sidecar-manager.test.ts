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

  it('latest overlapping start request wins over an in-flight startup', async () => {
    const firstChild = new MockChildProcess(7001);
    const secondChild = new MockChildProcess(7002);
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
      endpoint: 'http://127.0.0.1:9700',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
      healthTimeoutMs: 300,
    });

    const secondStart = manager.start({
      mode: 'embedded',
      command: 'python3',
      args: ['-m', 'agent_s'],
      endpoint: 'http://127.0.0.1:9701',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
      healthTimeoutMs: 300,
    });

    expect(secondStart).not.toBe(firstStart);

    const latestStatus = await secondStart;
    expect(firstChild.killed).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[0]).toBe('python');
    expect(spawnMock.mock.calls[1]?.[0]).toBe('python3');
    expect(latestStatus.state).toBe('running');
    expect(latestStatus.endpoint).toBe('http://127.0.0.1:9701');
    expect(latestStatus.pid).toBe(7002);

    firstProbe.resolve(createHealthyResponse());
    const staleStatus = await firstStart;

    expect(staleStatus.state).toBe('running');
    expect(staleStatus.endpoint).toBe('http://127.0.0.1:9701');
    expect(staleStatus.pid).toBe(7002);
    expect(manager.getStatus().endpoint).toBe('http://127.0.0.1:9701');
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

  it('applies the latest config to status and health probes after overlapping starts', async () => {
    const firstChild = new MockChildProcess(7201);
    const secondChild = new MockChildProcess(7202);
    const firstProbe = createDeferred<Response>();
    const spawnMock = vi
      .fn<SpawnFunction>()
      .mockReturnValueOnce(firstChild as unknown as ReturnType<SpawnFunction>)
      .mockReturnValueOnce(secondChild as unknown as ReturnType<SpawnFunction>);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstProbe.promise)
      .mockResolvedValueOnce(createHealthyResponse())
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

    const latestStatus = await manager.start({
      mode: 'embedded',
      command: 'python3',
      args: ['-m', 'agent_s', '--port', '10801'],
      endpoint: 'http://127.0.0.1:9721/base',
      startupTimeoutMs: 1_000,
      startupPollIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
      healthTimeoutMs: 300,
    });

    firstProbe.resolve(createHealthyResponse());
    await firstStart;

    const probed = await manager.health({ probe: true });

    expect(latestStatus.endpoint).toBe('http://127.0.0.1:9721/base');
    expect(probed.endpoint).toBe('http://127.0.0.1:9721/base');
    expect(probed.pid).toBe(7202);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:9721/base/health',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:9721/base/health',
      expect.objectContaining({ method: 'GET' }),
    );
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
      name: 'path-based launcher',
      command: './agent_s',
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
    expect(extractHealthFromPayload({ status: 'running' })).toBe(true);
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
    expect(
      extractHealthFromPayload({ healthy: false, status: 'running' }),
    ).toBe(false);
    expect(extractHealthFromPayload({ status: '' })).toBe(false);
    expect(extractHealthFromPayload({ status: ['running'] })).toBe(false);
  });
});
