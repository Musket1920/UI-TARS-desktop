/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { OpenAI } from 'openai';
import { initIpc } from '@ui-tars/electron-ipc/main';
import { logger } from '../logger';

const t = initIpc.create();

type OpenAIConfig = ConstructorParameters<typeof OpenAI>[0];

const PROBE_TIMEOUT_MS = 1_500;
type ProbeRequestOptions = OpenAI.RequestOptions;

const PROBE_REQUEST_OPTIONS = {
  maxRetries: 0,
} satisfies ProbeRequestOptions;

type SettingInputBase = {
  baseUrl: string;
  modelName: string;
};

type VLMCheckInput = SettingInputBase & {
  apiKey: string; // secretlint-disable-line @secretlint/secretlint-rule-pattern
};

type LocalVLMConnectionErrorCode =
  | 'INVALID_URL'
  | 'UNREACHABLE'
  | 'MODEL_NOT_FOUND'
  | 'RESPONSES_UNSUPPORTED'
  | 'UNKNOWN';

type LocalVLMConnectionTestResult = {
  ok: boolean;
  modelAvailable: boolean;
  useResponsesApi: boolean;
  errorCode: LocalVLMConnectionErrorCode | null;
  errorMessage: string | null;
};

type OpenAIErrorRecord = Record<string, unknown>;

const CONNECTION_ERROR_HINTS = [
  'apiconnectionerror',
  'connect',
  'connection',
  'econnrefused',
  'ehostunreach',
  'enotfound',
  'fetch failed',
  'network',
  'refused',
  'socket',
  'timed out',
  'timeout',
  'unreachable',
] as const;

const MODEL_NOT_FOUND_HINTS = [
  'model_not_found',
  'model not found',
  'no such model',
  'does not exist',
] as const;

const RESPONSES_UNSUPPORTED_HINTS = [
  '/responses',
  'post /responses',
  'response api',
  'responses api',
  'responses endpoint',
] as const;

const RESPONSES_UNSUPPORTED_REASON_HINTS = [
  'not implemented',
  'unsupported',
  'unknown endpoint',
  'not found',
  'does not support',
] as const;

const buildOpenAIConfig = (
  baseURL: string,
  apiKeyValue: string,
): OpenAIConfig => {
  const config = { baseURL } as OpenAIConfig;
  (config as Record<string, unknown>)['apiKey'] = apiKeyValue;
  return config;
};

const getOpenAIClient = (input: VLMCheckInput): OpenAI => {
  return new OpenAI(buildOpenAIConfig(input.baseUrl, input.apiKey));
};

const createProbeTimeoutError = (probeName: string): Error => {
  return new Error(
    `Localhost ${probeName} probe timed out after ${PROBE_TIMEOUT_MS}ms.`,
  );
};

const createProbeRequestOptions = (signal?: AbortSignal): ProbeRequestOptions => {
  return {
    ...PROBE_REQUEST_OPTIONS,
    signal,
  };
};

const createModelNotFoundError = (modelName: string): Error => {
  const error = new Error(`The model \`${modelName}\` does not exist`);
  const errorRecord = error as Error & { code?: string; status?: number };

  errorRecord.code = 'model_not_found';
  errorRecord.status = 404;

  return error;
};

const withProbeTimeout = async <T>(
  probeName: string,
  operation: (requestOptions: ProbeRequestOptions) => Promise<T>,
): Promise<T> => {
  const timeoutSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const timeoutError = createProbeTimeoutError(probeName);

  try {
    return await operation(createProbeRequestOptions(timeoutSignal));
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw timeoutError;
    }

    throw error;
  }
};

const isValidHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const getErrorRecord = (value: unknown): OpenAIErrorRecord | null => {
  return typeof value === 'object' && value !== null
    ? (value as OpenAIErrorRecord)
    : null;
};

const pushStringDetails = (details: string[], value: unknown): void => {
  if (typeof value === 'string' && value.length > 0) {
    details.push(value.toLowerCase());
  }
};

const collectErrorDetails = (error: unknown): string[] => {
  const details: string[] = [];
  const record = getErrorRecord(error);
  const nestedError = getErrorRecord(record?.error);
  const cause = getErrorRecord(record?.cause);

  pushStringDetails(details, record?.name);
  pushStringDetails(details, record?.message);
  pushStringDetails(details, record?.code);
  pushStringDetails(details, nestedError?.message);
  pushStringDetails(details, nestedError?.code);
  pushStringDetails(details, nestedError?.type);
  pushStringDetails(details, cause?.message);
  pushStringDetails(details, cause?.code);
  pushStringDetails(details, cause?.name);

  return details;
};

const getErrorStatus = (error: unknown): number | undefined => {
  const record = getErrorRecord(error);
  return typeof record?.status === 'number' ? record.status : undefined;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  const record = getErrorRecord(error);
  if (typeof record?.message === 'string' && record.message.length > 0) {
    return record.message;
  }

  const nestedError = getErrorRecord(record?.error);
  if (
    typeof nestedError?.message === 'string' &&
    nestedError.message.length > 0
  ) {
    return nestedError.message;
  }

  return 'Unknown error';
};

const hasHint = (error: unknown, hints: readonly string[]): boolean => {
  const details = collectErrorDetails(error);
  return details.some((detail) => {
    return hints.some((hint) => detail.includes(hint));
  });
};

const hasResponsesUnsupportedHint = (error: unknown): boolean => {
  const details = collectErrorDetails(error);

  return details.some((detail) => {
    return (
      RESPONSES_UNSUPPORTED_HINTS.some((hint) => detail.includes(hint)) &&
      RESPONSES_UNSUPPORTED_REASON_HINTS.some((hint) => detail.includes(hint))
    );
  });
};

const classifyModelProbeError = (
  error: unknown,
): LocalVLMConnectionErrorCode => {
  if (hasHint(error, CONNECTION_ERROR_HINTS)) {
    return 'UNREACHABLE';
  }

  if (hasHint(error, MODEL_NOT_FOUND_HINTS)) {
    return 'MODEL_NOT_FOUND';
  }

  if (getErrorStatus(error) === 404) {
    return 'MODEL_NOT_FOUND';
  }

  return 'UNKNOWN';
};

const classifyResponsesProbeError = (
  error: unknown,
): LocalVLMConnectionErrorCode => {
  if (hasHint(error, CONNECTION_ERROR_HINTS)) {
    return 'UNREACHABLE';
  }

  if (hasResponsesUnsupportedHint(error)) {
    return 'RESPONSES_UNSUPPORTED';
  }

  const status = getErrorStatus(error);
  if (status === 404 || status === 405 || status === 501) {
    return 'RESPONSES_UNSUPPORTED';
  }

  return 'UNKNOWN';
};

const probeModelAvailability = async (
  input: VLMCheckInput,
  requestOptions: ProbeRequestOptions = PROBE_REQUEST_OPTIONS,
): Promise<boolean> => {
  const openai = getOpenAIClient(input);
  const models = await openai.models.list(requestOptions);

  if (models.data.length === 0) {
    return false;
  }

  if (!models.data.some((model) => model.id === input.modelName)) {
    throw createModelNotFoundError(input.modelName);
  }

  return true;
};

const probeResponsesApiSupport = async (
  input: VLMCheckInput,
  requestOptions: ProbeRequestOptions = PROBE_REQUEST_OPTIONS,
): Promise<boolean> => {
  const openai = getOpenAIClient(input);
  const result = await openai.responses.create(
    {
      model: input.modelName,
      input: 'return 1+1=?',
      stream: false,
    },
    requestOptions,
  );

  return Boolean(result?.id || result?.previous_response_id);
};

export const settingRoute = t.router({
  checkVLMResponseApiSupport: t.procedure
    .input<VLMCheckInput>()
    .handle(async ({ input }) => {
      try {
        return await withProbeTimeout('responses API', (requestOptions) =>
          probeResponsesApiSupport(input, requestOptions),
        );
      } catch (e) {
        logger.warn('[checkVLMResponseApiSupport] failed:', e);
        return false;
      }
    }),
  checkModelAvailability: t.procedure
    .input<VLMCheckInput>()
    .handle(async ({ input }) => {
      try {
        return await withProbeTimeout('model availability', (requestOptions) =>
          probeModelAvailability(input, requestOptions),
        );
      } catch (e) {
        logger.warn('[checkModelAvailability] failed:', e);
        throw e;
      }
    }),
  testLocalVLMConnection: t.procedure
    .input<VLMCheckInput>()
    .handle(async ({ input }) => {
      if (!isValidHttpUrl(input.baseUrl)) {
        return {
          ok: false,
          modelAvailable: false,
          useResponsesApi: false,
          errorCode: 'INVALID_URL',
          errorMessage: 'Invalid base URL. Use a full http(s) URL.',
        } satisfies LocalVLMConnectionTestResult;
      }

      try {
        const modelAvailable = await withProbeTimeout(
          'model availability',
          (requestOptions) => probeModelAvailability(input, requestOptions),
        );
        if (!modelAvailable) {
          return {
            ok: false,
            modelAvailable: false,
            useResponsesApi: false,
            errorCode: 'UNKNOWN',
            errorMessage: 'Model availability probe returned an empty response.',
          } satisfies LocalVLMConnectionTestResult;
        }
      } catch (error) {
        logger.warn('[testLocalVLMConnection] model probe failed:', error);
        return {
          ok: false,
          modelAvailable: false,
          useResponsesApi: false,
          errorCode: classifyModelProbeError(error),
          errorMessage: getErrorMessage(error),
        } satisfies LocalVLMConnectionTestResult;
      }

      try {
        const useResponsesApi = await withProbeTimeout(
          'responses API',
          (requestOptions) => probeResponsesApiSupport(input, requestOptions),
        );

        if (!useResponsesApi) {
          return {
            ok: false,
            modelAvailable: true,
            useResponsesApi: false,
            errorCode: 'UNKNOWN',
            errorMessage: 'Responses API probe returned an empty response.',
          } satisfies LocalVLMConnectionTestResult;
        }

        return {
          ok: true,
          modelAvailable: true,
          useResponsesApi: true,
          errorCode: null,
          errorMessage: null,
        } satisfies LocalVLMConnectionTestResult;
      } catch (error) {
        logger.warn('[testLocalVLMConnection] responses probe failed:', error);
        const errorCode = classifyResponsesProbeError(error);

        if (errorCode === 'RESPONSES_UNSUPPORTED') {
          return {
            ok: true,
            modelAvailable: true,
            useResponsesApi: false,
            errorCode,
            errorMessage: getErrorMessage(error),
          } satisfies LocalVLMConnectionTestResult;
        }

        return {
          ok: false,
          modelAvailable: true,
          useResponsesApi: false,
          errorCode,
          errorMessage: getErrorMessage(error),
        } satisfies LocalVLMConnectionTestResult;
      }
    }),
});
