/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { type LocalStore, VLMProviderV2 } from '@main/store/types';

export type AgentSEngineType = 'openai' | 'huggingface';

export type AgentSEngineParams = {
  engine_type: AgentSEngineType;
  model: string;
  base_url: string;
  api_key: string;
};

export type AgentSProviderConfig = {
  provider: AgentSEngineType;
  model: string;
  baseURL: string;
  apiKey: string;
  useResponsesApi: boolean;
  engineParamsForGeneration: AgentSEngineParams;
  engineParamsForGrounding: AgentSEngineParams;
};

const REQUIRED_VLM_FIELDS = [
  'vlmProvider',
  'vlmModelName',
  'vlmBaseUrl',
  'vlmApiKey',
] as const;

const SENSITIVE_KEY_PATTERN = /(api[-_]?key|token|authorization)/i;

const PROVIDER_TO_ENGINE_TYPE: Record<VLMProviderV2, AgentSEngineType> = {
  [VLMProviderV2.ui_tars_1_0]: 'huggingface',
  [VLMProviderV2.ui_tars_1_5]: 'huggingface',
  [VLMProviderV2.doubao_1_5]: 'openai',
  [VLMProviderV2.doubao_1_5_vl]: 'openai',
};

const isVLMProviderV2 = (value: string): value is VLMProviderV2 => {
  return Object.values(VLMProviderV2).includes(value as VLMProviderV2);
};

const requireNonEmptySetting = (
  settings: LocalStore,
  field: (typeof REQUIRED_VLM_FIELDS)[number],
): string => {
  const value = settings[field];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required Agent-S setting: ${field}`);
  }

  return value.trim();
};

const normalizeProvider = (provider: string): AgentSEngineType => {
  if (!isVLMProviderV2(provider)) {
    throw new Error(
      `Unsupported Agent-S provider mapping for vlmProvider: ${provider}`,
    );
  }

  return PROVIDER_TO_ENGINE_TYPE[provider];
};

const redactValue = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    return '[REDACTED]';
  }

  if (value.length <= 4) {
    return '*'.repeat(value.length);
  }

  return `${value.slice(0, 2)}***${value.slice(-2)}`;
};

export const redactSensitiveConfig = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveConfig(item)) as T;
  }

  if (value !== null && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};

    Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? redactValue(entry)
        : redactSensitiveConfig(entry);
    });

    return redacted as T;
  }

  return value;
};

export const mapProviderToAgentSConfig = (
  settings: LocalStore,
): AgentSProviderConfig => {
  const provider = normalizeProvider(
    requireNonEmptySetting(settings, 'vlmProvider'),
  );
  const model = requireNonEmptySetting(settings, 'vlmModelName');
  const baseURL = requireNonEmptySetting(settings, 'vlmBaseUrl');
  const apiKeyValue = requireNonEmptySetting(settings, 'vlmApiKey');

  const engineParams: AgentSEngineParams = {
    engine_type: provider,
    model,
    base_url: baseURL,
    api_key: apiKeyValue,
  };

  return {
    provider,
    model,
    baseURL,
    apiKey: apiKeyValue,
    useResponsesApi: Boolean(settings.useResponsesApi),
    engineParamsForGeneration: engineParams,
    // Grounding intentionally mirrors generation today; wire a dedicated
    // grounding model here later if Agent-S grows separate grounding config.
    engineParamsForGrounding: { ...engineParams },
  } as AgentSProviderConfig;
};
