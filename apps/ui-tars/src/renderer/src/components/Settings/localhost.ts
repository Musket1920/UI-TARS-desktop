/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export const LOCALHOST_BASE_URL_HINT = 'http://127.0.0.1:11434/v1';

export type LocalConnectionErrorCode =
  | 'INVALID_URL'
  | 'UNREACHABLE'
  | 'MODEL_NOT_FOUND'
  | 'RESPONSES_UNSUPPORTED'
  | 'UNKNOWN';

export type LocalConnectionTestResult = {
  ok: boolean;
  modelAvailable: boolean;
  useResponsesApi: boolean;
  errorCode: LocalConnectionErrorCode | null;
  errorMessage: string | null;
};

type LocalConnectionFormValues = {
  vlmBaseUrl: string;
  vlmApiKey: string;
  vlmModelName: string;
};

export type LocalConnectionSnapshot = {
  baseUrl: string;
  apiKey: string; // secretlint-disable-line @secretlint/secretlint-rule-pattern -- settings snapshot field name only
  modelName: string;
};

export type LocalConnectionTestState = {
  status: 'idle' | 'testing' | 'completed';
  snapshot: LocalConnectionSnapshot | null;
  result: LocalConnectionTestResult | null;
};

export const isValidHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

export const normalizeLocalConnectionSnapshot = (
  values: LocalConnectionFormValues,
): LocalConnectionSnapshot => {
  return {
    baseUrl: values.vlmBaseUrl.trim(),
    apiKey: values.vlmApiKey.trim(), // secretlint-disable-line @secretlint/secretlint-rule-pattern -- settings snapshot field name only
    modelName: values.vlmModelName.trim(),
  };
};

export const areLocalConnectionSnapshotsEqual = (
  left: LocalConnectionSnapshot | null,
  right: LocalConnectionSnapshot,
): boolean => {
  if (!left) {
    return false;
  }

  return (
    left.baseUrl === right.baseUrl &&
    left.apiKey === right.apiKey && // secretlint-disable-line @secretlint/secretlint-rule-pattern -- settings snapshot field name only
    left.modelName === right.modelName
  );
};

export const getLocalConnectionFeedback = (
  result: LocalConnectionTestResult,
): {
  tone: 'success' | 'error' | 'warning';
  title: string;
  description: string;
} => {
  const errorCode = result.errorCode;

  switch (errorCode) {
    case 'INVALID_URL':
      return {
        tone: 'error',
        title: 'Invalid localhost URL',
        description: `Use a full http(s) URL, for example ${LOCALHOST_BASE_URL_HINT}.`,
      };
    case 'UNREACHABLE':
      return {
        tone: 'error',
        title: 'Cannot reach the localhost server',
        description:
          'Make sure the server is running, then verify the full base URL and port.',
      };
    case 'MODEL_NOT_FOUND':
      return {
        tone: 'error',
        title: 'Model not found',
        description:
          'The local server responded, but this model name is not available there.',
      };
    case 'RESPONSES_UNSUPPORTED':
      return {
        tone: 'warning',
        title: 'Connected to localhost',
        description:
          'The model works, but the Responses API is unavailable. UI-TARS will use chat completions for this connection.',
      };
    case 'UNKNOWN':
      return {
        tone: 'error',
        title: 'Connection test failed',
        description:
          result.errorMessage ??
          'The localhost server returned an unexpected response.',
      };
    case null:
      return {
        tone: 'success',
        title: 'Connected to localhost',
        description:
          'The model responded successfully and the Responses API is available.',
      };
    default: {
      const exhaustiveCheck: never = errorCode;
      void exhaustiveCheck;
      return {
        tone: 'error',
        title: 'Unknown feedback state',
        description: 'An unsupported localhost connection result was received.',
      };
    }
  }
};
