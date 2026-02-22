/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
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

describe('circuit-breaker-recover Agent-S circuit breaker', () => {
  const originalThreshold =
    process.env.AGENT_S_CIRCUIT_BREAKER_FAILURE_THRESHOLD;
  const originalCooldown = process.env.AGENT_S_CIRCUIT_BREAKER_COOLDOWN_MS;

  beforeEach(() => {
    process.env.AGENT_S_CIRCUIT_BREAKER_FAILURE_THRESHOLD = '2';
    process.env.AGENT_S_CIRCUIT_BREAKER_COOLDOWN_MS = '1000';
  });

  afterEach(() => {
    if (typeof originalThreshold === 'string') {
      process.env.AGENT_S_CIRCUIT_BREAKER_FAILURE_THRESHOLD = originalThreshold;
    } else {
      delete process.env.AGENT_S_CIRCUIT_BREAKER_FAILURE_THRESHOLD;
    }

    if (typeof originalCooldown === 'string') {
      process.env.AGENT_S_CIRCUIT_BREAKER_COOLDOWN_MS = originalCooldown;
    } else {
      delete process.env.AGENT_S_CIRCUIT_BREAKER_COOLDOWN_MS;
    }
  });

  it('closes breaker after cooldown when recovery probe is healthy', async () => {
    let now = 100;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true }),
    } as Response);

    const manager = new AgentSSidecarManager({
      fetch: fetchMock,
      now: () => now,
    });

    await manager.start({
      mode: 'external',
      endpoint: 'http://127.0.0.1:19000',
      startupTimeoutMs: 100,
      startupPollIntervalMs: 50,
      heartbeatIntervalMs: 10_000,
      healthTimeoutMs: 100,
    });

    manager.recordCircuitFailure({
      source: 'runtime',
      reasonCode: 'AGENT_S_TURN_TIMEOUT',
    });
    manager.recordCircuitFailure({
      source: 'runtime',
      reasonCode: 'AGENT_S_TURN_TIMEOUT',
    });

    const opened = manager.getCircuitBreakerStatus();
    expect(opened.state).toBe('open');

    now = 1_200;
    const decision = await manager.evaluateDispatchCircuit();

    expect(decision.allowAgentS).toBe(true);
    expect(decision.reasonCode).toBe('circuit_breaker_recovered');
    expect(decision.breaker.state).toBe('closed');
    expect(decision.breaker.consecutiveFailures).toBe(0);
  });

  it('re-opens breaker after cooldown when recovery probe fails', async () => {
    let now = 200;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ healthy: true }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ status: 'down' }),
      } as Response);

    const manager = new AgentSSidecarManager({
      fetch: fetchMock,
      now: () => now,
    });

    await manager.start({
      mode: 'external',
      endpoint: 'http://127.0.0.1:19001',
      startupTimeoutMs: 100,
      startupPollIntervalMs: 50,
      heartbeatIntervalMs: 10_000,
      healthTimeoutMs: 100,
    });

    manager.recordCircuitFailure({
      source: 'runtime',
      reasonCode: 'AGENT_S_TURN_TIMEOUT',
    });
    manager.recordCircuitFailure({
      source: 'runtime',
      reasonCode: 'AGENT_S_TURN_TIMEOUT',
    });

    now = 1_250;
    const decision = await manager.evaluateDispatchCircuit();

    expect(decision.allowAgentS).toBe(false);
    expect(decision.reasonCode).toBe('circuit_breaker_open');
    expect(decision.breaker.state).toBe('open');
    expect(decision.breaker.consecutiveFailures).toBeGreaterThanOrEqual(2);
  });
});
