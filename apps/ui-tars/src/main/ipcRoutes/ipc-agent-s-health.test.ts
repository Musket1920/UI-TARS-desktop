/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { store } from '@main/store/create';
import { AgentSSidecarMode, EngineMode } from '@main/store/types';
import {
  resetAgentSLifecycle,
  setAgentSActive,
} from '@main/services/agentS/lifecycle';

import { agentRoute } from './agent';

type GetAgentSHealthContext = Parameters<
  typeof agentRoute.getAgentSHealth.handle
>[0]['context'];
type GetAgentRuntimeStatusContext = Parameters<
  typeof agentRoute.getAgentRuntimeStatus.handle
>[0]['context'];

const {
  sidecarHealthMock,
  sidecarGetStatusMock,
  sidecarGetCircuitBreakerStatusMock,
  loggerWarnMock,
} = vi.hoisted(() => ({
  sidecarHealthMock: vi.fn(),
  sidecarGetStatusMock: vi.fn(),
  sidecarGetCircuitBreakerStatusMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('@main/logger', () => ({
  logger: {
    warn: loggerWarnMock,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock('@main/services/runAgent', () => ({
  runAgent: vi.fn(),
}));

vi.mock('@main/services/agentS/telemetry', () => ({
  sanitizeAgentSBoundaryPayload: <T>(value: T) => value,
}));

vi.mock('@main/window/index', () => ({
  showWindow: vi.fn(),
}));

vi.mock('@main/window/ScreenMarker', () => ({
  closeScreenMarker: vi.fn(),
}));

vi.mock('@main/store/create', () => {
  const state = {
    thinking: false,
    abortController: null,
    status: 'init',
    agentSPaused: false,
  };

  return {
    store: {
      setState: vi.fn((patch) => {
        Object.assign(state, patch);
      }),
      getState: vi.fn(() => state),
    },
  };
});

vi.mock('@main/store/setting', () => ({
  SettingStore: {
    getStore: vi.fn(() => ({
      engineMode: EngineMode.AgentS,
      agentSSidecarMode: AgentSSidecarMode.Embedded,
    })),
  },
}));

vi.mock('@main/services/agentS/sidecarManager', () => ({
  classifyAgentSFailureReason: (reasonCode: string | null | undefined) => {
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
    if (reasonCode === 'AGENT_S_PREDICTION_MALFORMED') {
      return 'invalid_output';
    }
    return 'unavailable';
  },
  agentSSidecarManager: {
    health: sidecarHealthMock,
    getStatus: sidecarGetStatusMock,
    getCircuitBreakerStatus: sidecarGetCircuitBreakerStatusMock,
  },
}));

describe('ipc-agent-s-health route payload', () => {
  const invokeHealthRoute = (input?: { forceProbe?: boolean }) => {
    return agentRoute.getAgentSHealth.handle({
      input,
      context: {} as GetAgentSHealthContext,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentSLifecycle();
    setAgentSActive(false);
    store.getState().thinking = false;
    store.getState().agentSPaused = false;

    sidecarGetStatusMock.mockReturnValue({
      state: 'unhealthy',
      mode: 'embedded',
      healthy: false,
      endpoint: 'http://127.0.0.1:10800',
      pid: null,
      checkedAt: 1,
      lastHeartbeatAt: null,
      reason: 'heartbeat_failed',
    });
    sidecarGetCircuitBreakerStatusMock.mockReturnValue({
      state: 'closed',
      open: false,
      canProbe: false,
      nextProbeAt: null,
      failureThreshold: 3,
      cooldownMs: 20_000,
      consecutiveFailures: 0,
      openedAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      lastFailureClass: null,
      lastRecoveryAt: null,
    });
  });

  afterEach(() => {
    resetAgentSLifecycle();
    setAgentSActive(false);
  });

  it('uses cached status by default without probing live health', async () => {
    sidecarGetStatusMock.mockReturnValue({
      state: 'running',
      mode: 'embedded',
      healthy: true,
      endpoint: 'http://127.0.0.1:10800',
      pid: 4242,
      checkedAt: 1700000000123,
      lastHeartbeatAt: 1700000000123,
    });

    const payload = await invokeHealthRoute();

    expect(payload).toEqual({
      status: 'healthy',
      message: 'Agent-S is healthy.',
      reasonCode: 'ok',
      failureClass: null,
      circuitBreaker: {
        state: 'closed',
        open: false,
        canProbe: false,
        nextProbeAt: null,
      },
      engine: {
        mode: EngineMode.AgentS,
        runtime: 'legacy',
        active: false,
        paused: false,
        thinking: false,
      },
      timestamp: 1700000000123,
    });

    expect(payload).not.toHaveProperty('pid');
    expect(payload).not.toHaveProperty('endpoint');
    expect(payload).not.toHaveProperty('reason');
    expect(sidecarHealthMock).not.toHaveBeenCalled();
    expect(sidecarGetStatusMock).toHaveBeenCalledTimes(1);
  });

  it('uses a live probe when explicitly requested', async () => {
    sidecarHealthMock.mockResolvedValue({
      state: 'running',
      mode: 'embedded',
      healthy: true,
      endpoint: 'http://127.0.0.1:10800',
      pid: 4242,
      checkedAt: 1700000000555,
      lastHeartbeatAt: 1700000000555,
    });

    const payload = await invokeHealthRoute({ forceProbe: true });

    expect(payload.status).toBe('healthy');
    expect(payload.timestamp).toBe(1700000000555);
    expect(sidecarHealthMock).toHaveBeenCalledWith({ probe: true });
    expect(sidecarGetStatusMock).not.toHaveBeenCalled();
  });

  it('maps stopped sidecar to offline status', async () => {
    sidecarHealthMock.mockResolvedValue({
      state: 'stopped',
      mode: null,
      healthy: false,
      endpoint: null,
      pid: null,
      checkedAt: 1700000000999,
      lastHeartbeatAt: null,
      reason: 'stop_requested',
    });

    const payload = await invokeHealthRoute({ forceProbe: true });

    expect(payload.status).toBe('offline');
    expect(payload.reasonCode).toBe('stop_requested');
    expect(payload.message).toContain('unavailable');
    expect(payload.timestamp).toBe(1700000000999);
  });

  it('reports model loading message while sidecar is starting', async () => {
    sidecarHealthMock.mockResolvedValue({
      state: 'starting',
      mode: null,
      healthy: false,
      endpoint: null,
      pid: null,
      checkedAt: 1700000004444,
      lastHeartbeatAt: null,
      reason: 'startup_timeout',
    });

    const payload = await invokeHealthRoute({ forceProbe: true });

    expect(payload.status).toBe('degraded');
    expect(payload.message).toContain('Model loading...');
    expect(payload.reasonCode).toBe('startup_timeout');
    expect(payload.failureClass).toBe('timeout');
    expect(payload.timestamp).toBe(1700000004444);
  });

  it('warns and falls back to current status when probe throws', async () => {
    const error = new Error('probe failed');
    sidecarHealthMock.mockRejectedValue(error);
    sidecarGetStatusMock.mockReturnValue({
      state: 'unhealthy',
      mode: 'embedded',
      healthy: false,
      endpoint: 'http://127.0.0.1:10800',
      pid: null,
      checkedAt: 1700000001234,
      lastHeartbeatAt: null,
      reason: 'heartbeat_failed',
    });

    const payload = await invokeHealthRoute({ forceProbe: true });

    expect(payload.status).toBe('degraded');
    expect(payload.reasonCode).toBe('heartbeat_failed');
    expect(payload.timestamp).toBe(1700000001234);
    expect(sidecarHealthMock).toHaveBeenCalledWith({ probe: true });
    expect(sidecarGetStatusMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Agent-S health probe failed, falling back to cached status:',
      error,
    );
  });

  it('maps circuit breaker open to deterministic degraded fallback message', async () => {
    sidecarHealthMock.mockResolvedValue({
      state: 'running',
      mode: 'embedded',
      healthy: true,
      endpoint: 'http://127.0.0.1:10800',
      pid: 4242,
      checkedAt: 1700000002222,
      lastHeartbeatAt: 1700000002222,
    });
    sidecarGetCircuitBreakerStatusMock.mockReturnValue({
      state: 'open',
      open: true,
      canProbe: false,
      nextProbeAt: 1700000022222,
      failureThreshold: 3,
      cooldownMs: 20_000,
      consecutiveFailures: 4,
      openedAt: 1700000002222,
      lastFailureAt: 1700000002222,
      lastFailureCode: 'AGENT_S_TURN_TIMEOUT',
      lastFailureClass: 'timeout',
      lastRecoveryAt: null,
    });

    const payload = await invokeHealthRoute({ forceProbe: true });

    expect(payload.status).toBe('degraded');
    expect(payload.reasonCode).toBe('circuit_breaker_open');
    expect(payload.failureClass).toBe('timeout');
    expect(payload.message).toContain('temporarily bypassed');
    expect(payload.circuitBreaker).toEqual({
      state: 'open',
      open: true,
      canProbe: false,
      nextProbeAt: 1700000022222,
    });
  });

  it('exposes literal INVALID_OUTPUT reasonCode when invalid output fallback occurs', async () => {
    sidecarHealthMock.mockResolvedValue({
      state: 'running',
      mode: 'embedded',
      healthy: false,
      endpoint: 'http://127.0.0.1:10800',
      pid: 4243,
      checkedAt: 1700000003333,
      lastHeartbeatAt: 1700000003333,
      reason: 'AGENT_S_PREDICTION_MALFORMED',
    });

    const payload = await invokeHealthRoute({ forceProbe: true });

    expect(payload.status).toBe('degraded');
    expect(payload.failureClass).toBe('invalid_output');
    expect(payload.reasonCode).toBe('INVALID_OUTPUT');
    expect(payload.message).toContain('invalid output');
  });

  it('returns runtime control status with safe control flags', async () => {
    sidecarHealthMock.mockResolvedValue({
      state: 'running',
      mode: 'embedded',
      healthy: true,
      endpoint: 'http://127.0.0.1:10800',
      pid: 100,
      checkedAt: 1700000000123,
      lastHeartbeatAt: 1700000000123,
    });

    const runtime = await agentRoute.getAgentRuntimeStatus.handle({
      input: undefined,
      context: {} as GetAgentRuntimeStatusContext,
    });

    expect(runtime.status).toBe('idle');
    expect(runtime.engine).toEqual({
      mode: EngineMode.AgentS,
      runtime: 'legacy',
      active: false,
      paused: false,
      thinking: false,
    });
    expect(runtime.controls).toEqual({
      canRun: true,
      canPause: false,
      canResume: false,
      canStop: false,
    });
  });
});
