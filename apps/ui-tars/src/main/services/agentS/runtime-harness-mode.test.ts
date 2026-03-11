/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import { createRuntimeSidecarHarness } from './sidecarTestHarness';

const BASE_ENDPOINT = 'http://127.0.0.1:10800';

const modeSpecs = [
  {
    mode: 'ok' as const,
    startState: 'running',
    startHealthy: true,
    startReason: undefined,
    healthState: 'running',
    healthReason: undefined,
    pid: 4301,
  },
  {
    mode: 'timeout' as const,
    startState: 'timeout',
    startHealthy: false,
    startReason: 'startup_timeout',
    healthState: 'timeout',
    healthReason: 'startup_timeout',
    pid: null,
  },
  {
    mode: 'malformed' as const,
    startState: 'unhealthy',
    startHealthy: false,
    startReason: 'health_http_error',
    healthState: 'unhealthy',
    healthReason: 'health_http_error',
    pid: 4310,
  },
] as const;

describe('runtime-harness-mode createRuntimeSidecarHarness', () => {
  describe.each(modeSpecs)('%s behavior', (spec) => {
    it('runs lifecycle without touching real processes', async () => {
      const harness = createRuntimeSidecarHarness(spec.mode);

      expect(harness.fixtureMode).toBe(spec.mode);

      const started = await harness.start();
      expect(started.state).toBe(spec.startState);
      expect(started.healthy).toBe(spec.startHealthy);
      expect(started.endpoint).toBe(BASE_ENDPOINT);
      expect(started.pid).toBe(spec.pid);
      if (spec.startReason) {
        expect(started.reason).toBe(spec.startReason);
      } else {
        expect(started.reason).toBeUndefined();
      }
      expect(harness.getStatus()).toBe(started);

      const healthStatus = await harness.health();
      expect(healthStatus.state).toBe(spec.healthState);
      expect(healthStatus.reason).toBe(spec.healthReason);
      expect(harness.getStatus()).toBe(healthStatus);

      const stopped = await harness.stop();
      expect(stopped.state).toBe('stopped');
      expect(stopped.pid).toBeNull();
      expect(stopped.reason).toBe('stop_requested');
      expect(harness.getStatus()).toBe(stopped);

      expect(
        harness.setTelemetryCorrelation({ traceId: 'abc', requestId: null }),
      ).toBeUndefined();
    });
  });

  it('rejects start for crash mode and still surfaces failure statuses', async () => {
    const harness = createRuntimeSidecarHarness('crash');

    await expect(harness.start()).rejects.toThrow(
      'Sidecar simulated crash during startup',
    );

    const health = await harness.health();
    expect(health.state).toBe('unhealthy');
    expect(health.reason).toBe('child_process_exit');
    expect(health.pid).toBeNull();
    expect(health.endpoint).toBe(BASE_ENDPOINT);

    const stopped = await harness.stop();
    expect(stopped.state).toBe('stopped');
    expect(harness.getStatus()).toBe(stopped);
    expect(harness.setTelemetryCorrelation({ foo: 'bar' })).toBeUndefined();
  });

  it('accepts probe-style health calls and marks probe failures explicitly', async () => {
    const harness = createRuntimeSidecarHarness('malformed', {
      state: 'running',
      healthy: true,
    });

    const started = await harness.start();
    expect(started.state).toBe('running');
    expect(started.healthy).toBe(true);

    const probed = await harness.health({ probe: true });
    expect(probed.state).toBe('unhealthy');
    expect(probed.healthy).toBe(false);
    expect(probed.reason).toBe('health_http_error');
    expect(probed.transientProbeFailure).toBe(true);
    expect(harness.getStatus()).toBe(probed);

    const nonProbeHealth = await harness.health();
    expect(nonProbeHealth.state).toBe('unhealthy');
    expect(nonProbeHealth.healthy).toBe(false);
    expect(nonProbeHealth.reason).toBe('health_http_error');
    expect(nonProbeHealth.transientProbeFailure).toBeUndefined();
  });
});
