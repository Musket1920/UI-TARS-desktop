/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusEnum } from '@ui-tars/shared/types';
import { VLMProviderV2 } from '@main/store/types';
import type { AppState, LocalStore } from '@main/store/types';
import { runAgentSRuntimeLoop } from './runtimeLoop';
import type { AgentSRuntimeOperator } from './runtimeLoop';

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

const createSettings = (): LocalStore =>
  ({
    vlmProvider: VLMProviderV2.ui_tars_1_0,
    vlmModelName: 'ui-tars-1.0',
    vlmBaseUrl: 'https://api.ui-tars.local',
    vlmApiKey: 'local',
    loopIntervalInMs: 100,
    useResponsesApi: false,
  }) as LocalStore;

const createOperator = (): AgentSRuntimeOperator => ({
  screenshot: vi.fn(async () => ({
    base64: 'ZmFrZQ==',
    scaleFactor: 1,
  })),
  execute: vi.fn(async () => ({
    status: StatusEnum.END,
  })),
});

const createStateHandlers = () => {
  const history: AppState[] = [];
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
    history.push(nextState);
  });

  const getState = vi.fn(() => currentState);

  return { setState, getState, history };
};

const createFakeSidecarManager = () => {
  const healthyStatus = {
    state: 'running',
    mode: 'embedded',
    healthy: true,
    endpoint: 'http://127.0.0.1:10800',
    pid: 4242,
    checkedAt: 1_000,
    lastHeartbeatAt: 1_000,
  } as const;

  return {
    health: vi.fn(async () => ({ ...healthyStatus })),
    getStatus: vi.fn(() => ({ ...healthyStatus })),
  };
};

const successFetch: typeof fetch = async () => {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      action: 'finished',
      prediction: 'finished',
    }),
  } as unknown as Response;
};

const timeoutFetch: typeof fetch = async (_url, options) => {
  return new Promise((_resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      reject(new Error('fetch aborted'));
      return;
    }

    const onAbort = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('fetch aborted'));
    };

    signal?.addEventListener('abort', onAbort);
  }) as unknown as ReturnType<typeof fetch>;
};

describe('agent-s-runtime runAgentSRuntimeLoop', () => {
  beforeEach(() => {
    translateAgentSActionMock.mockReset();
    jimpFromBuffer.mockResolvedValue({
      bitmap: {
        width: 640,
        height: 360,
      },
    });
  });

  it('executes one successful turn and records state updates', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator = createOperator();
    const sidecarManager = createFakeSidecarManager();

    translateAgentSActionMock.mockReturnValue({
      ok: true,
      normalizedAction: 'finished',
      parsed: {
        action_type: 'finished',
        action_inputs: {},
        thought: '',
        reflection: null,
      },
    });

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'wrap up the job',
      sessionHistoryMessages: [],
      deps: {
        fetch: successFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.END);
    expect(result.stepsExecuted).toBeGreaterThanOrEqual(1);
    expect(operator.execute).toHaveBeenCalledTimes(1);
    expect(history.some((state) => state.status === StatusEnum.END)).toBe(true);
  });

  it('surfaces a timeout error when prediction never resolves', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator = createOperator();
    const sidecarManager = createFakeSidecarManager();

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'trigger timeout',
      sessionHistoryMessages: [],
      deps: {
        fetch: timeoutFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_TURN_TIMEOUT');
    expect(result.stepsExecuted).toBeGreaterThanOrEqual(0);
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      true,
    );
  });
});
