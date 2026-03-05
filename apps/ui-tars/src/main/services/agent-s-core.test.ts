/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalStore, VLMProviderV2 } from '@main/store/types';

vi.mock('@main/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  },
}));

import {
  classifyAgentSFailureReason,
  type SidecarFailureReason,
} from './agentS/sidecarManager';
import {
  createSidecarFixture,
  type SidecarFixtureMode,
} from './agentS/sidecarTestHarness';
import {
  ensureAgentSNotPaused,
  isAgentSPaused,
  pauseAgentSRuntime,
  resumeAgentSRuntime,
  setAgentSActive,
} from './agentS/lifecycle';
import {
  mapProviderToAgentSConfig,
  redactSensitiveConfig,
} from './agentS/providerMap';
import { translateAgentSAction } from './agentS/actionTranslator';

describe('agent-s-core integration maps and translator', () => {
  it('redacts provider secrets and normalizes known actions', () => {
    const settings = {
      vlmProvider: VLMProviderV2.ui_tars_1_5,
      vlmModelName: 'agent-s-core-test',
      vlmBaseUrl: 'https://vlm.tests.local',
      vlmApiKey: 'secret-value',
      useResponsesApi: true,
    } as LocalStore;

    const config = mapProviderToAgentSConfig(settings);
    expect(config.provider).toBe('huggingface');

    const redacted = redactSensitiveConfig(config);
    expect(redacted.apiKey).not.toBe(config.apiKey);
    expect(redacted.apiKey).toMatch(/\*+/);

    const translation = translateAgentSAction("left_single(point='(10,20)')");
    expect(translation.ok).toBe(true);
    if (translation.ok) {
      expect(translation.parsed.action_type).toBe('left_click');
      expect(translation.parsed.action_inputs.start_box).toBe('[10,20,10,20]');
    }
  });
});

describe('agent-s-core lifecycle guard', () => {
  afterEach(() => {
    setAgentSActive(false);
  });

  it('pauses and resumes safely while waiting for resume', async () => {
    setAgentSActive(true);
    expect(pauseAgentSRuntime()).toBe(true);
    expect(isAgentSPaused()).toBe(true);

    const waitPromise = ensureAgentSNotPaused();
    let resumed = false;
    waitPromise.then(() => {
      resumed = true;
    });

    await Promise.resolve();
    expect(resumed).toBe(false);

    resumeAgentSRuntime();
    await waitPromise;

    expect(resumed).toBe(true);
    expect(isAgentSPaused()).toBe(false);
  });
});

describe('agent-s-core dispatcher safety guard classification', () => {
  const guardSpecs: Array<{
    mode: SidecarFixtureMode;
    expected: SidecarFailureReason | null;
    fallback: string;
  }> = [
    { mode: 'ok', expected: null, fallback: 'degraded_fallback' },
    { mode: 'timeout', expected: 'startup_timeout', fallback: 'timeout' },
    {
      mode: 'malformed',
      expected: 'health_http_error',
      fallback: 'unavailable',
    },
    { mode: 'crash', expected: 'child_process_exit', fallback: 'unavailable' },
  ];

  it.each(guardSpecs)(
    'classifies %s fixture reason as %s fallback',
    ({ mode, expected, fallback }) => {
      const fixture = createSidecarFixture(mode);
      expect(fixture.status.endpoint).toBe('http://127.0.0.1:10800');
      expect(fixture.status.healthy).toBe(mode === 'ok');

      const failureCode = fixture.status.reason ?? null;
      expect(failureCode).toBe(expected);

      const classified = classifyAgentSFailureReason(failureCode);
      expect(classified).toBe(fallback);
    },
  );
});
