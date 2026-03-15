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
  VLMConnectionMode,
  Operator,
  EngineMode,
  AgentSSidecarMode,
} from './types';

const OptionalUrlOrEmptyStringSchema = z
  .union([z.literal(''), z.string().url()])
  .optional();
const UrlOrEmptyStringSchema = z.union([z.literal(''), z.string().url()]);
const NonEmptyStringOrEmptySchema = z.union([z.literal(''), z.string().min(1)]);

const PresetSourceSchema = z.object({
  type: z.enum(['local', 'remote']),
  url: z.string().url().optional(),
  autoUpdate: z.boolean().optional(),
  lastUpdated: z.number().optional(),
});

const CommonSettingsSchema = z.object({
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
  reportStorageBaseUrl: OptionalUrlOrEmptyStringSchema,
  utioBaseUrl: OptionalUrlOrEmptyStringSchema,
});

const ManagedVLMSettingsSchema = z.object({
  vlmProvider: z.nativeEnum(VLMProviderV2).optional(),
  vlmBaseUrl: z.string().url(),
  vlmApiKey: z.string().min(1),
  vlmModelName: z.string().min(1),
  useResponsesApi: z.boolean().optional(),
});

const LocalStoreVLMSettingsSchema = z.object({
  vlmProvider: z.union([z.literal(''), z.nativeEnum(VLMProviderV2)]).optional(),
  vlmBaseUrl: UrlOrEmptyStringSchema,
  vlmApiKey: z.string().default(''),
  vlmModelName: NonEmptyStringOrEmptySchema,
  useResponsesApi: z.boolean().default(false),
});

const usesManagedVLMConnectionMode = (mode: VLMConnectionMode): boolean => {
  return mode === VLMConnectionMode.Managed;
};

const hasConfiguredManagedVLMFields = (data: {
  vlmProvider?: VLMProviderV2 | '';
  vlmBaseUrl: string;
  vlmApiKey: string;
  vlmModelName: string;
}): boolean => {
  return (
    (data.vlmProvider !== undefined && data.vlmProvider !== '') ||
    data.vlmBaseUrl.length > 0 ||
    data.vlmApiKey.length > 0 ||
    data.vlmModelName.length > 0
  );
};

const usesLegacyUITARSEngineMode = (engineMode?: EngineMode): boolean => {
  return (engineMode ?? EngineMode.UITARS) === EngineMode.UITARS;
};

const usesSupportedLocalhostOpenAICompatibleSettings = (
  engineMode: EngineMode | undefined,
  operator: Operator,
): boolean => {
  return (
    usesLegacyUITARSEngineMode(engineMode) &&
    (operator === Operator.LocalComputer || operator === Operator.LocalBrowser)
  );
};

export const PresetSchema = CommonSettingsSchema.extend({
  ...ManagedVLMSettingsSchema.shape,
  presetSource: PresetSourceSchema.optional(),
});

export const LocalStoreSchema = CommonSettingsSchema.extend({
  vlmConnectionMode: z
    .nativeEnum(VLMConnectionMode)
    .default(VLMConnectionMode.Managed),
  ...LocalStoreVLMSettingsSchema.shape,
  presetSource: PresetSourceSchema.optional(),
}).superRefine((data, ctx) => {
  if (
    data.vlmConnectionMode === VLMConnectionMode.LocalhostOpenAICompatible &&
    data.vlmBaseUrl.length === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_small,
      minimum: 1,
      inclusive: true,
      path: ['vlmBaseUrl'],
      type: 'string',
    });
  }

  if (
    data.vlmConnectionMode === VLMConnectionMode.LocalhostOpenAICompatible &&
    data.vlmModelName.length === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_small,
      minimum: 1,
      inclusive: true,
      path: ['vlmModelName'],
      type: 'string',
    });
  }

  if (
    usesManagedVLMConnectionMode(data.vlmConnectionMode) &&
    hasConfiguredManagedVLMFields(data) &&
    data.vlmApiKey.length === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_small,
      minimum: 1,
      inclusive: true,
      path: ['vlmApiKey'],
      type: 'string',
    });
  }

  if (
    data.vlmConnectionMode === VLMConnectionMode.LocalhostOpenAICompatible &&
    !usesSupportedLocalhostOpenAICompatibleSettings(
      data.engineMode,
      data.operator,
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['vlmConnectionMode'],
      message:
        '`localhost-openai-compatible` is only supported for legacy UI-TARS local operators',
    });
  }
});

export type PresetSource = z.infer<typeof PresetSourceSchema>;
export type PresetStore = z.infer<typeof PresetSchema>;
export type LocalStore = z.infer<typeof LocalStoreSchema>;

export const validatePreset = (data: unknown): PresetStore => {
  return PresetSchema.parse(data);
};

export const validateLocalStore = (data: unknown): LocalStore => {
  const result = LocalStoreSchema.safeParse(data);

  if (!result.success) {
    console.error('[validateLocalStore] schema violation:', result.error.format());
    throw result.error;
  }

  return result.data;
};
