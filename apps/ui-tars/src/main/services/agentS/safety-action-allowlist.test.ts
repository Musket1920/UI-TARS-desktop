/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusEnum } from '@ui-tars/shared/types';
import { VLMProviderV2 } from '@main/store/types';
import type { AppState, LocalStore } from '@main/store/types';

const { translateAgentSActionMock, jimpFromBuffer } = vi.hoisted(() => ({
  translateAgentSActionMock: vi.fn(),
  jimpFromBuffer: vi.fn(async () => ({
    bitmap: {
      width: 640,
      height: 360,
    },
  })),
}));

vi.mock('./actionTranslator', () => ({
  translateAgentSAction: translateAgentSActionMock,
}));

vi.mock('@main/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('jimp', () => ({
  Jimp: {
    fromBuffer: jimpFromBuffer,
  },
}));

import { runAgentSRuntimeLoop } from './runtimeLoop';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=';

const createSettings = (): LocalStore =>
  ({
    vlmProvider: VLMProviderV2.ui_tars_1_0,
    vlmModelName: 'ui-tars-1.0',
    vlmBaseUrl: 'https://api.ui-tars.local',
    vlmApiKey: 'local',
    loopIntervalInMs: 100,
    useResponsesApi: false,
  }) as LocalStore;

const createStateHandlers = () => {
  let currentState: AppState = {
    theme: 'dark',
    ensurePermissions: {},
    instructions: null,
    restUserData: null,
    status: StatusEnum.RUNNING,
    errorMsg: null,
    sessionHistoryMessages: [],
    messages: [],
    abortController: null,
    thinking: false,
    agentSPaused: false,
    browserAvailable: true,
  };

  const setState = vi.fn((nextState: AppState) => {
    currentState = nextState;
  });

  const getState = vi.fn(() => currentState);

  return { setState, getState };
};

const successFetch: typeof fetch = async () => {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      action: 'left_click',
      prediction: 'left_click',
    }),
  } as unknown as Response;
};

const sidecarHealthyStatus = {
  state: 'running',
  mode: 'embedded',
  healthy: true,
  endpoint: 'http://127.0.0.1:10800',
  pid: 42,
  checkedAt: 1,
  lastHeartbeatAt: 1,
} as const;

describe('safety-action-allowlist runtime guard', () => {
  beforeEach(() => {
    translateAgentSActionMock.mockReset();
    jimpFromBuffer.mockResolvedValue({
      bitmap: {
        width: 640,
        height: 360,
      },
    });
  });

  it('returns ACTION_NOT_ALLOWED when translator rejects unsupported action', async () => {
    const { setState, getState } = createStateHandlers();
    const executeMock = vi.fn(async () => ({ status: StatusEnum.END }));

    translateAgentSActionMock.mockReturnValue({
      ok: false,
      code: 'TRANSLATION_UNSUPPORTED_ACTION',
      message: 'Unsupported Agent-S action: shell_exec',
    });

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator: {
        screenshot: vi.fn(async () => ({
          base64: TINY_PNG_BASE64,
          scaleFactor: 1,
        })),
        execute: executeMock,
      },
      instruction: 'test action allowlist',
      sessionHistoryMessages: [],
      deps: {
        fetch: successFetch,
        sidecarManager: {
          health: vi.fn(async () => ({ ...sidecarHealthyStatus })),
          getStatus: vi.fn(() => ({ ...sidecarHealthyStatus })),
        },
        now: () => 123,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('ACTION_NOT_ALLOWED');
    expect(result.error?.translationCode).toBe('ACTION_NOT_ALLOWED');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('returns ACTION_NOT_ALLOWED when translated parsed action is not allowlisted', async () => {
    const { setState, getState } = createStateHandlers();
    const executeMock = vi.fn(async () => ({ status: StatusEnum.END }));

    translateAgentSActionMock.mockReturnValue({
      ok: true,
      normalizedAction: 'left_click',
      parsed: {
        action_type: 'shell_exec',
        action_inputs: {},
        thought: '',
        reflection: null,
      },
    } as const);

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator: {
        screenshot: vi.fn(async () => ({
          base64: TINY_PNG_BASE64,
          scaleFactor: 1,
        })),
        execute: executeMock,
      },
      instruction: 'test parsed action allowlist',
      sessionHistoryMessages: [],
      deps: {
        fetch: successFetch,
        sidecarManager: {
          health: vi.fn(async () => ({ ...sidecarHealthyStatus })),
          getStatus: vi.fn(() => ({ ...sidecarHealthyStatus })),
        },
        now: () => 456,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('ACTION_NOT_ALLOWED');
    expect(result.error?.translationCode).toBe('ACTION_NOT_ALLOWED');
    expect(executeMock).not.toHaveBeenCalled();
  });
});
