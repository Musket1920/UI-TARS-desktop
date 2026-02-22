/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import { validatePreset } from './validate';
import {
  AgentSSidecarMode,
  EngineMode,
  Operator,
  SearchEngineForSettings,
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

describe('validatePreset schema for Agent-S settings', () => {
  it('accepts legacy presets without Agent-S fields', () => {
    const validated = validatePreset(basePreset());
    expect(validated.engineMode).toBeUndefined();
    expect(validated.agentSSidecarMode).toBeUndefined();
    expect(validated.agentSEnableLocalEnv).toBeUndefined();
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
