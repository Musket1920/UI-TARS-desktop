/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { OpenAI } from 'openai';
import { initIpc } from '@ui-tars/electron-ipc/main';
import { logger } from '../logger';

const t = initIpc.create();

type OpenAIConfig = ConstructorParameters<typeof OpenAI>[0];

type SettingInputBase = {
  baseUrl: string;
  modelName: string;
};

type VLMCheckInput = SettingInputBase & Record<string, string>;

const buildOpenAIConfig = (
  baseURL: string,
  apiKeyValue: string,
): OpenAIConfig => {
  const config = { baseURL } as OpenAIConfig;
  (config as Record<string, unknown>)['apiKey'] = apiKeyValue;
  return config;
};

export const settingRoute = t.router({
  checkVLMResponseApiSupport: t.procedure
    .input<VLMCheckInput>()
    .handle(async ({ input }) => {
      try {
        const openai = new OpenAI(
          buildOpenAIConfig(input.baseUrl, input.apiKey),
        );
        const result = await openai.responses.create({
          model: input.modelName,
          input: 'return 1+1=?',
          stream: false,
        });
        return Boolean(result?.id || result?.previous_response_id);
      } catch (e) {
        logger.warn('[checkVLMResponseApiSupport] failed:', e);
        return false;
      }
    }),
  checkModelAvailability: t.procedure
    .input<VLMCheckInput>()
    .handle(async ({ input }) => {
      const openai = new OpenAI(buildOpenAIConfig(input.baseUrl, input.apiKey));
      const completion = await openai.chat.completions.create({
        model: input.modelName,
        messages: [{ role: 'user', content: 'return 1+1=?' }],
        stream: false,
      });

      return Boolean(completion?.id || completion.choices[0].message.content);
    }),
});
