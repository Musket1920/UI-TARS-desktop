/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { emitAgentSTelemetryMock, fetchMock } = vi.hoisted(() => ({
  emitAgentSTelemetryMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@main/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock('./agentS/telemetry', () => ({
  emitAgentSTelemetry: emitAgentSTelemetryMock,
  sanitizeAgentSPayload: <T>(value: T) => value,
  sanitizeAgentSBoundaryPayload: <T>(value: T) => value,
  sanitizeCommandArgs: (args: string[]) => args,
}));

import {
  AgentSSidecarManager,
  classifyAgentSFailureReason,
  type AgentSFallbackClass,
  type SidecarStartConfig,
} from './agentS/sidecarManager';
import { createSidecarFixture } from './agentS/sidecarTestHarness';

const setCurrentConfig = (
  manager: AgentSSidecarManager,
  config: SidecarStartConfig,
) => {
  (manager as unknown as Record<string, unknown>)['currentConfig'] = config;
};

describe('agent-s failure paths', () => {
  beforeEach(() => {
    emitAgentSTelemetryMock.mockReset();
    fetchMock.mockReset();
  });

  describe('failure reason classification', () => {
    const classificationMatrix: Array<{
      reason: string | null | undefined;
      fallback: AgentSFallbackClass;
    }> = [
      { reason: 'startup_timeout', fallback: 'timeout' },
      { reason: 'AGENT_S_OPERATOR_TIMEOUT', fallback: 'timeout' },
      { reason: 'health_http_error', fallback: 'unavailable' },
      { reason: 'AGENT_S_PREDICTION_MALFORMED', fallback: 'invalid_output' },
      { reason: 'circuit_breaker_open', fallback: 'degraded_fallback' },
      { reason: null, fallback: 'degraded_fallback' },
    ];

    it.each(classificationMatrix)(
      'maps %s reason to %s fallback',
      ({ reason, fallback }) => {
        expect(classifyAgentSFailureReason(reason)).toBe(fallback);
      },
    );
  });

  describe('deterministic fixture statuses', () => {
    const fixtureMatrix = [
      {
        mode: 'timeout' as const,
        expectedState: 'timeout',
        reason: 'startup_timeout',
        fallback: 'timeout' as AgentSFallbackClass,
      },
      {
        mode: 'malformed' as const,
        expectedState: 'unhealthy',
        reason: 'health_http_error',
        fallback: 'unavailable' as AgentSFallbackClass,
      },
      {
        mode: 'crash' as const,
        expectedState: 'unhealthy',
        reason: 'child_process_exit',
        fallback: 'unavailable' as AgentSFallbackClass,
      },
    ];

    it.each(fixtureMatrix)(
      'reports %s fixture with reason %s and fallback %s',
      ({ mode, expectedState, reason, fallback }) => {
        const fixture = createSidecarFixture(mode);
        expect(fixture.status.state).toBe(expectedState);
        expect(fixture.status.reason).toBe(reason);
        expect(classifyAgentSFailureReason(fixture.status.reason ?? null)).toBe(
          fallback,
        );
      },
    );
  });

  describe('circuit breaker fallback telemetry', () => {
    it('opens circuit after repeated timeout failures and records fallback data', () => {
      const manager = new AgentSSidecarManager({
        fetch: fetchMock as typeof fetch,
      });

      const { failureThreshold } = manager.getCircuitBreakerStatus();
      expect(failureThreshold).toBeGreaterThanOrEqual(1);

      for (let i = 0; i < failureThreshold; i += 1) {
        manager.recordCircuitFailure({
          reasonCode: 'AGENT_S_TURN_TIMEOUT',
        });
      }

      const status = manager.getCircuitBreakerStatus();
      expect(status.state).toBe('open');
      expect(status.lastFailureCode).toBe('AGENT_S_TURN_TIMEOUT');
      expect(status.lastFailureClass).toBe('timeout');
      expect(status.consecutiveFailures).toBeGreaterThanOrEqual(
        failureThreshold,
      );

      expect(emitAgentSTelemetryMock).toHaveBeenCalledWith(
        'agent_s.fallback.triggered',
        expect.objectContaining({
          failureReason: 'AGENT_S_TURN_TIMEOUT',
          failureClass: 'timeout',
          reasonCode: 'circuit_breaker_open',
          state: 'open',
        }),
        expect.objectContaining({ level: 'warn' }),
      );
      expect(emitAgentSTelemetryMock).toHaveBeenCalledWith(
        'engine_fallback_triggered',
        expect.objectContaining({
          failureReason: 'AGENT_S_TURN_TIMEOUT',
          failureClass: 'timeout',
          reasonCode: 'circuit_breaker_open',
          state: 'open',
        }),
        expect.objectContaining({ level: 'warn' }),
      );
    });
  });

  describe('sidecar health failure telemetry', () => {
    it('emits fallback reason when health probe returns HTTP error', async () => {
      fetchMock.mockImplementation(async () => ({
        ok: false,
        status: 502,
        json: async () => ({}),
      }));

      const manager = new AgentSSidecarManager({
        fetch: fetchMock as typeof fetch,
      });

      setCurrentConfig(manager, {
        mode: 'external',
        endpoint: 'http://127.0.0.1:10800',
      });

      const status = await manager.health({ probe: true });
      expect(status.state).toBe('unhealthy');
      expect(status.reason).toBe('health_http_error');
      expect(status.healthy).toBe(false);

      expect(emitAgentSTelemetryMock).toHaveBeenCalledWith(
        'agent_s.fallback.triggered',
        expect.objectContaining({
          source: 'agent_s.sidecar',
          reasonCode: 'health_http_error',
        }),
        expect.objectContaining({ level: 'warn' }),
      );
    });
  });
});
