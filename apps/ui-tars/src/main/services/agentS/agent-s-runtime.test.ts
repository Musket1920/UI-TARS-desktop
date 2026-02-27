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
import { isAgentSActive, setAgentSActive } from './lifecycle';

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

const failingFetch: typeof fetch = async () => {
  throw new Error('network down');
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
    setAgentSActive(false);
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

    const deferredFetch = (() => {
      let resolveResponse: ((value: Response) => void) | undefined;
      const pending = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });

      const fetchMock: typeof fetch = async () => pending;

      return {
        fetchMock,
        resolve: () => {
          resolveResponse?.({
            ok: true,
            status: 200,
            json: async () => ({
              action: 'finished',
              prediction: 'finished',
            }),
          } as unknown as Response);
        },
      };
    })();

    const loopPromise = runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'wrap up the job',
      sessionHistoryMessages: [],
      deps: {
        fetch: deferredFetch.fetchMock,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(isAgentSActive()).toBe(true);

    deferredFetch.resolve();

    const result = await loopPromise;

    expect(result.status).toBe(StatusEnum.END);
    expect(result.stepsExecuted).toBeGreaterThanOrEqual(1);
    expect(operator.execute).toHaveBeenCalledTimes(1);
    expect(history.some((state) => state.status === StatusEnum.END)).toBe(true);
    expect(isAgentSActive()).toBe(false);
  });

  it('resets active lifecycle state after an error exit', async () => {
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
        fetch: failingFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_TURN_REQUEST_FAILED');
    expect(result.stepsExecuted).toBeGreaterThanOrEqual(0);
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      true,
    );
    expect(isAgentSActive()).toBe(false);
  });

  it('rejects malformed predict payload with AGENT_S_PREDICTION_MALFORMED', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator = createOperator();
    const sidecarManager = createFakeSidecarManager();

    const malformedPredictFetch: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ action: [] }),
      }) as Response;

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'produce malformed prediction',
      sessionHistoryMessages: [],
      deps: {
        fetch: malformedPredictFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_PREDICTION_MALFORMED');
    expect(result.error?.step).toBe(1);
    expect(operator.execute).not.toHaveBeenCalled();
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      true,
    );
    expect(isAgentSActive()).toBe(false);
  });
});
