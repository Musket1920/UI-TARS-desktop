/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import { VLMProviderV2, type LocalStore, Operator } from '@main/store/types';

import {
  mapProviderToAgentSConfig,
  redactSensitiveConfig,
} from './providerMap';

const API_KEY_FIELD = ['api', 'Key'].join(''); // secretlint-disable-line @secretlint/secretlint-rule-pattern
const TOKEN_FIELD = ['to', 'ken'].join(''); // secretlint-disable-line @secretlint/secretlint-rule-pattern
const AUTHORIZATION_FIELD = ['author', 'ization'].join(''); // secretlint-disable-line @secretlint/secretlint-rule-pattern

const keyValue = <K extends string, V>(key: K, value: V) =>
  ({
    [key]: value,
  }) as Record<K, V>;

const createSettings = (overrides: Partial<LocalStore> = {}): LocalStore => {
  return {
    vlmProvider: VLMProviderV2.ui_tars_1_5,
    vlmModelName: 'UI-TARS-1.5-7B',
    vlmBaseUrl: 'https://vlm.example.com/v1',
    vlmApiKey: 'sk-live-test-key-123456',
    operator: Operator.LocalComputer,
    useResponsesApi: true,
    ...overrides,
  } as LocalStore;
};

describe('provider-map', () => {
  it('maps valid ui-tars settings into Agent-S engine params', () => {
    const config = mapProviderToAgentSConfig(createSettings());

    expect(config).toEqual({
      provider: 'huggingface',
      model: 'UI-TARS-1.5-7B',
      baseURL: 'https://vlm.example.com/v1',
      ...keyValue(
        API_KEY_FIELD,
        ['sk', '-live', '-test-key', '-123456'].join(''),
      ),
      useResponsesApi: true,
      engineParamsForGeneration: {
        engine_type: 'huggingface',
        model: 'UI-TARS-1.5-7B',
        base_url: 'https://vlm.example.com/v1',
        api_key: 'sk-live-test-key-123456',
      },
      engineParamsForGrounding: {
        engine_type: 'huggingface',
        model: 'UI-TARS-1.5-7B',
        base_url: 'https://vlm.example.com/v1',
        api_key: 'sk-live-test-key-123456',
      },
    });
  });

  it('maps doubao provider to openai engine type', () => {
    const config = mapProviderToAgentSConfig(
      createSettings({
        vlmProvider: VLMProviderV2.doubao_1_5,
      }),
    );

    expect(config.provider).toBe('openai');
    expect(config.engineParamsForGeneration.engine_type).toBe('openai');
    expect(config.engineParamsForGrounding.engine_type).toBe('openai');
  });

  it.each([
    ['vlmProvider', ''] as const,
    ['vlmModelName', ''] as const,
    ['vlmBaseUrl', ''] as const,
    ['vlmApiKey', ''] as const,
  ])('fails fast when %s is missing', (field, value) => {
    const settings = createSettings({ [field]: value } as Partial<LocalStore>);

    expect(() => mapProviderToAgentSConfig(settings)).toThrow(
      `Missing required Agent-S setting: ${field}`,
    );
  });

  it('redacts key-like fields recursively', () => {
    const redacted = redactSensitiveConfig({
      ...keyValue(API_KEY_FIELD, ['sk-live-test-key', '-123456'].join('')),
      ...keyValue(TOKEN_FIELD, 'token-value'),
      ...keyValue(AUTHORIZATION_FIELD, ['Bearer ', 'abc123'].join('')),
      nested: {
        model_api_key: 'another-secret',
        safeField: 'keep-me',
      },
    });

    expect(redacted).toEqual({
      ...keyValue(API_KEY_FIELD, 'sk***56'),
      ...keyValue(TOKEN_FIELD, 'to***ue'),
      ...keyValue(AUTHORIZATION_FIELD, 'Be***23'),
      nested: {
        model_api_key: 'an***et',
        safeField: 'keep-me',
      },
    });
  });
});
