/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';

import {
  AGENT_S_SAFE_MAX_LOOP_INTERVAL_MS,
  AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
  AGENT_S_SAFE_MIN_LOOP_INTERVAL_MS,
  AGENT_S_SAFE_MIN_TURN_TIMEOUT_MS,
} from './safetyPolicy';
import {
  SearchEngineForSettings,
  VLMProviderV2,
  Operator,
  EngineMode,
  AgentSSidecarMode,
} from './types';

const PresetSourceSchema = z.object({
  type: z.enum(['local', 'remote']),
  url: z.string().url().optional(),
  autoUpdate: z.boolean().optional(),
  lastUpdated: z.number().optional(),
});

export const PresetSchema = z.object({
  // Local VLM Settings
  vlmProvider: z.nativeEnum(VLMProviderV2).optional(),
  vlmBaseUrl: z.string().url(),
  vlmApiKey: z.string().min(1),
  vlmModelName: z.string().min(1),
  useResponsesApi: z.boolean().optional(),

  // Chat Settings
  operator: z.nativeEnum(Operator),
  language: z.enum(['zh', 'en']).optional(),
  screenshotScale: z.number().min(0.1).max(1).optional(),
  maxLoopCount: z.number().min(25).max(200).optional(),
  loopIntervalInMs: z
    .number()
    .min(AGENT_S_SAFE_MIN_LOOP_INTERVAL_MS)
    .max(AGENT_S_SAFE_MAX_LOOP_INTERVAL_MS)
    .optional(),
  agentSTurnTimeoutMs: z
    .number()
    .min(AGENT_S_SAFE_MIN_TURN_TIMEOUT_MS)
    .max(AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS)
    .optional(),
  searchEngineForBrowser: z.nativeEnum(SearchEngineForSettings).optional(),
  engineMode: z.nativeEnum(EngineMode).optional(),
  agentSSidecarMode: z.nativeEnum(AgentSSidecarMode).optional(),
  agentSSidecarUrl: z.string().url().optional(),
  agentSSidecarPort: z.number().int().min(1).max(65535).optional(),
  agentSEnableLocalEnv: z.boolean().optional(),

  // Report Settings
  reportStorageBaseUrl: z.string().url().optional(),
  utioBaseUrl: z.string().url().optional(),
  presetSource: PresetSourceSchema.optional(),
});

export type PresetSource = z.infer<typeof PresetSourceSchema>;
export type LocalStore = z.infer<typeof PresetSchema>;

export const validatePreset = (data: unknown): LocalStore => {
  return PresetSchema.parse(data);
};
