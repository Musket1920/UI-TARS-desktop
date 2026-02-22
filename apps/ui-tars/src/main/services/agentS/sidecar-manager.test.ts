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
      json: async () => ({}),
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
});
