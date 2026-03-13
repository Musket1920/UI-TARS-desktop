/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import { validateLocalStore, validatePreset } from './validate';
import {
  AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS,
  AGENT_S_SAFE_MIN_LOOP_INTERVAL_MS,
  AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
} from './safetyPolicy';
import {
  AgentSSidecarMode,
  EngineMode,
  Operator,
  SearchEngineForSettings,
  VLMConnectionMode,
  VLMProviderV2,
} from './types';

const basePreset = () => ({
  vlmBaseUrl: 'https://vlm.example.com',
  vlmApiKey: 'test-api-key',
  vlmModelName: 'test-model',
  vlmProvider: VLMProviderV2.ui_tars_1_5,
  operator: Operator.LocalComputer,
  searchEngineForBrowser: SearchEngineForSettings.GOOGLE,
});

const baseLocalStore = () => ({
  ...basePreset(),
  vlmConnectionMode: VLMConnectionMode.Managed,
});

describe('validatePreset schema for Agent-S settings', () => {
  it('uses reviewer-visible Agent-S timeout bounds above three seconds', () => {
    expect(AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS).toBe(10_000);
    expect(AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS).toBe(30_000);
  });

  it('accepts legacy presets without Agent-S fields', () => {
    const validated = validatePreset(basePreset());
    expect(validated.engineMode).toBeUndefined();
    expect(validated.agentSSidecarMode).toBeUndefined();
    expect(validated.agentSEnableLocalEnv).toBeUndefined();
  });

  it('handles legacy empty payloads while rejecting malformed critical values', () => {
    const validated = validatePreset({
      ...basePreset(),
      engineMode: EngineMode.UITARS,
    });

    expect(validated.engineMode).toBe(EngineMode.UITARS);
    expect(validated.agentSSidecarMode).toBeUndefined();
    expect(validated.agentSSidecarUrl).toBeUndefined();
    expect(validated.agentSEnableLocalEnv).toBeUndefined();

    expect(() =>
      validatePreset({
        ...basePreset(),
        vlmBaseUrl: '',
      }),
    ).toThrow(/vlmBaseUrl/);
  });

  it('accepts Agent-S turn timeout bounds', () => {
    const validated = validatePreset({
      ...basePreset(),
      agentSTurnTimeoutMs: AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
    });

    expect(validated.agentSTurnTimeoutMs).toBe(
      AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
    );
  });

  it('accepts loop intervals at the dedicated loop interval safety floor', () => {
    const validated = validatePreset({
      ...basePreset(),
      loopIntervalInMs: AGENT_S_SAFE_MIN_LOOP_INTERVAL_MS,
    });

    expect(validated.loopIntervalInMs).toBe(AGENT_S_SAFE_MIN_LOOP_INTERVAL_MS);
  });

  it('rejects loop intervals below the dedicated loop interval safety floor', () => {
    expect(() =>
      validatePreset({
        ...basePreset(),
        loopIntervalInMs: AGENT_S_SAFE_MIN_LOOP_INTERVAL_MS - 1,
      }),
    ).toThrow(/loopIntervalInMs/);
  });

  it('rejects Agent-S turn timeouts above the raised max', () => {
    expect(() =>
      validatePreset({
        ...basePreset(),
        agentSTurnTimeoutMs: AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS + 1,
      }),
    ).toThrow(/agentSTurnTimeoutMs/);
  });

  it('accepts Agent-S config with remote sidecar details', () => {
    const validated = validatePreset({
      ...basePreset(),
      engineMode: EngineMode.AgentS,
      agentSSidecarMode: AgentSSidecarMode.Remote,
      agentSSidecarUrl: 'https://agent-s.local',
      agentSSidecarPort: 10800,
      agentSEnableLocalEnv: false,
    });

    expect(validated.engineMode).toBe(EngineMode.AgentS);
    expect(validated.agentSSidecarMode).toBe(AgentSSidecarMode.Remote);
    expect(validated.agentSSidecarUrl).toBe('https://agent-s.local');
    expect(validated.agentSSidecarPort).toBe(10800);
    expect(validated.agentSEnableLocalEnv).toBe(false);
  });

  it('rejects invalid Agent-S sidecar URL', () => {
    expect(() =>
      validatePreset({
        ...basePreset(),
        engineMode: EngineMode.AgentS,
        agentSSidecarUrl: 'not-a-url',
      }),
    ).toThrow(/agentSSidecarUrl/);
  });

  it('rejects invalid Agent-S sidecar port', () => {
    expect(() =>
      validatePreset({
        ...basePreset(),
        agentSSidecarPort: 70000,
      }),
    ).toThrow(/agentSSidecarPort/);
  });
});

describe('validateLocalStore schema for localhost connection mode', () => {
  it('accepts localhost mode with an empty API key and persisted responses capability', () => {
    const validated = validateLocalStore({
      ...baseLocalStore(),
      vlmConnectionMode: VLMConnectionMode.LocalhostOpenAICompatible,
      vlmBaseUrl: 'http://127.0.0.1:11434/v1',
      vlmApiKey: '',
      vlmModelName: 'ui-tars-1.5-7b',
      useResponsesApi: true,
    });

    expect(validated.vlmConnectionMode).toBe(
      VLMConnectionMode.LocalhostOpenAICompatible,
    );
    expect(validated.vlmApiKey).toBe('');
    expect(validated.vlmModelName).toBe('ui-tars-1.5-7b');
    expect(validated.useResponsesApi).toBe(true);
  });

  it('defaults managed mode and the persisted responses capability flag', () => {
    const validated = validateLocalStore({
      operator: Operator.LocalComputer,
      vlmBaseUrl: 'https://vlm.example.com',
      vlmApiKey: 'test-api-key',
      vlmModelName: 'test-model',
    });

    expect(validated.vlmConnectionMode).toBe(VLMConnectionMode.Managed);
    expect(validated.useResponsesApi).toBe(false);
  });

  it('rejects managed mode when the API key is blank', () => {
    expect(() =>
      validateLocalStore({
        ...baseLocalStore(),
        vlmApiKey: '',
      }),
    ).toThrow(/vlmApiKey/);
  });

  it('accepts empty persisted report URLs', () => {
    const validated = validateLocalStore({
      ...baseLocalStore(),
      reportStorageBaseUrl: '',
      utioBaseUrl: '',
    });

    expect(validated.reportStorageBaseUrl).toBe('');
    expect(validated.utioBaseUrl).toBe('');
  });

  it.each(['reportStorageBaseUrl', 'utioBaseUrl'] as const)(
    'rejects invalid non-empty %s values',
    (field) => {
      expect(() =>
        validateLocalStore({
          ...baseLocalStore(),
          [field]: 'not-a-url',
        }),
      ).toThrow(new RegExp(field));
    },
  );

  it('rejects localhost mode when Agent-S is selected', () => {
    expect(() =>
      validateLocalStore({
        ...baseLocalStore(),
        engineMode: EngineMode.AgentS,
        vlmConnectionMode: VLMConnectionMode.LocalhostOpenAICompatible,
        vlmBaseUrl: 'http://127.0.0.1:11434/v1',
        vlmApiKey: '',
        vlmModelName: 'ui-tars-1.5-7b',
      }),
    ).toThrow(/legacy UI-TARS local operators/);
  });

  it.each([Operator.RemoteComputer, Operator.RemoteBrowser])(
    'rejects localhost mode for unsupported operator %s',
    (operator) => {
      expect(() =>
        validateLocalStore({
          ...baseLocalStore(),
          engineMode: EngineMode.UITARS,
          operator,
          vlmConnectionMode: VLMConnectionMode.LocalhostOpenAICompatible,
          vlmBaseUrl: 'http://127.0.0.1:11434/v1',
          vlmApiKey: '',
          vlmModelName: 'ui-tars-1.5-7b',
        }),
      ).toThrow(/legacy UI-TARS local operators/);
    },
  );
});
