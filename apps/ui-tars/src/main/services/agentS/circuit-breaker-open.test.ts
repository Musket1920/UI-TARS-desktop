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

describe('circuit-breaker-open Agent-S circuit breaker', () => {
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

  it('opens breaker after consecutive failures and bypasses Agent-S dispatch', async () => {
    let now = 10;
    const manager = new AgentSSidecarManager({
      fetch: async () => {
        throw new Error('not needed');
      },
      now: () => now,
    });

    manager.recordCircuitFailure({
      source: 'runtime',
      reasonCode: 'AGENT_S_TURN_TIMEOUT',
    });
    const stillClosed = manager.getCircuitBreakerStatus();
    expect(stillClosed.state).toBe('closed');
    expect(stillClosed.consecutiveFailures).toBe(1);
    expect(stillClosed.failureThreshold).toBe(2);

    now = 11;
    manager.recordCircuitFailure({
      source: 'runtime',
      reasonCode: 'AGENT_S_TURN_TIMEOUT',
    });
    const opened = manager.getCircuitBreakerStatus();
    expect(opened.state).toBe('open');
    expect(opened.consecutiveFailures).toBe(2);
    expect(opened.openedAt).toBe(11);
    expect(opened.failureThreshold).toBe(2);

    const decision = await manager.evaluateDispatchCircuit();
    expect(decision.allowAgentS).toBe(false);
    expect(decision.reasonCode).toBe('circuit_breaker_open');
    expect(decision.breaker.state).toBe('open');
  });

  it('defaults failure threshold to 5 when env override is absent', () => {
    delete process.env.AGENT_S_CIRCUIT_BREAKER_FAILURE_THRESHOLD;
    const manager = new AgentSSidecarManager();
    const status = manager.getCircuitBreakerStatus();
    expect(status.failureThreshold).toBe(5);
  });
});
