/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import {
  createSidecarFixture,
  deterministicFixtureHealthPayloads,
  SidecarFixture,
  SidecarFixtureMode,
} from './sidecarTestHarness';

const BASE_ENDPOINT = 'http://127.0.0.1:10800';

type ModeExpectation = {
  mode: SidecarFixtureMode;
  expectedState: SidecarFixture['status']['state'];
  healthy: boolean;
  statusPid: number | null;
  spawnPid: number;
  statusReason?: string;
  statusErrorIncludes?: string;
  fetchVerifier: (fixture: SidecarFixture) => Promise<void>;
};

const modeExpectations: ModeExpectation[] = [
  {
    mode: 'ok',
    expectedState: 'running',
    healthy: true,
    statusPid: 4301,
    spawnPid: 4301,
    fetchVerifier: async (fixture) => {
      const response = await fixture.fetch();
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        deterministicFixtureHealthPayloads.ok,
      );
    },
  },
  {
    mode: 'timeout',
    expectedState: 'timeout',
    healthy: false,
    statusPid: null,
    spawnPid: 4500,
    statusReason: 'startup_timeout',
    statusErrorIncludes: 'startup timeout',
    fetchVerifier: async (fixture) => {
      await expect(fixture.fetch()).rejects.toThrow(
        'Fixture timeout: sidecar did not respond in time',
      );
    },
  },
  {
    mode: 'malformed',
    expectedState: 'unhealthy',
    healthy: false,
    statusPid: 4310,
    spawnPid: 4310,
    statusReason: 'health_http_error',
    statusErrorIncludes: 'malformed payload',
    fetchVerifier: async (fixture) => {
      const response = await fixture.fetch();
      expect(response.ok).toBe(false);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual(
        deterministicFixtureHealthPayloads.malformed,
      );
    },
  },
  {
    mode: 'crash',
    expectedState: 'unhealthy',
    healthy: false,
    statusPid: 4322,
    spawnPid: 4322,
    statusReason: 'child_process_exit',
    statusErrorIncludes: 'simulated sidecar crash',
    fetchVerifier: async (fixture) => {
      await expect(fixture.fetch()).rejects.toThrow(
        'Fixture crash: sidecar terminated before health event',
      );
    },
  },
];

describe('createSidecarFixture', () => {
  describe.each(modeExpectations)('%s mode', (expectation) => {
    it('exposes deterministic metadata', () => {
      const fixture = createSidecarFixture(expectation.mode);

      expect(fixture.mode).toBe(expectation.mode);
      expect(fixture.endpoint).toBe(BASE_ENDPOINT);
      expect(fixture.status.state).toBe(expectation.expectedState);
      expect(fixture.status.mode).toBe('embedded');
      expect(fixture.status.healthy).toBe(expectation.healthy);
      expect(fixture.status.endpoint).toBe(BASE_ENDPOINT);
      expect(fixture.status.pid).toBe(expectation.statusPid);
      if (expectation.statusReason) {
        expect(fixture.status.reason).toBe(expectation.statusReason);
      } else {
        expect(fixture.status.reason).toBeUndefined();
      }
      if (expectation.statusErrorIncludes) {
        expect(fixture.status.error).toEqual(
          expect.stringContaining(expectation.statusErrorIncludes),
        );
      }
      expect(fixture.payload).toEqual(
        deterministicFixtureHealthPayloads[expectation.mode],
      );
    });

    it('spawns a predictable process', () => {
      const fixture = createSidecarFixture(expectation.mode);
      const process = fixture.spawn();

      expect(process.pid).toBe(expectation.spawnPid);
      expect(process.killed).toBe(false);
      expect(process.exitCode).toBeNull();
    });

    it('provides the right fetch behavior for each mode', async () => {
      const fixture = createSidecarFixture(expectation.mode);
      await expectation.fetchVerifier(fixture);
    });
  });
});
