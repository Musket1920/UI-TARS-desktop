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

const createDeferredHealthSidecarManager = () => {
  const healthyStatus = {
    state: 'running',
    mode: 'embedded',
    healthy: true,
    endpoint: 'http://127.0.0.1:10800',
    pid: 4242,
    checkedAt: 1_000,
    lastHeartbeatAt: 1_000,
  } as const;

  let resolveHealth: ((value: typeof healthyStatus) => void) | undefined;
  const healthPending = new Promise<typeof healthyStatus>((resolve) => {
    resolveHealth = resolve;
  });

  return {
    health: vi.fn(async () => healthPending),
    getStatus: vi.fn(() => ({ ...healthyStatus })),
    resolveHealth: () => {
      resolveHealth?.({ ...healthyStatus });
    },
  };
};

const failingFetch: typeof fetch = async () => {
  throw new Error('network down');
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createPredictResponse = (
  action: string,
  prediction = action,
): Response => {
  return {
    ok: true,
    status: 200,
    json: async () => ({ action, prediction }),
  } as Response;
};

const createTimerDeps = () => {
  type ScheduledTimer = {
    callback: () => void;
    ms: number;
    cleared: boolean;
  };

  const scheduled: ScheduledTimer[] = [];

  const setTimeout = Object.assign(
    vi.fn((callback: TimerHandler, ms?: number) => {
      const timer: ScheduledTimer = {
        callback: callback as () => void,
        ms: typeof ms === 'number' ? ms : 0,
        cleared: false,
      };
      scheduled.push(timer);
      return timer as unknown as ReturnType<typeof globalThis.setTimeout>;
    }),
    {
      __promisify__: globalThis.setTimeout.__promisify__,
    },
  ) as unknown as typeof globalThis.setTimeout;

  const clearTimeout = vi.fn(((
    timer: ReturnType<typeof globalThis.setTimeout>,
  ) => {
    (timer as unknown as ScheduledTimer).cleared = true;
  }) as typeof globalThis.clearTimeout);

  return {
    scheduled,
    setTimeout,
    clearTimeout,
  };
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

  it('sets RUNNING and active only after sidecar preflight succeeds, then clears active after a successful run', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator = createOperator();
    const sidecarManager = createDeferredHealthSidecarManager();

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

    expect(isAgentSActive()).toBe(false);
    expect(history.map((state) => state.status)).not.toContain(
      StatusEnum.RUNNING,
    );

    sidecarManager.resolveHealth();
    await flushMicrotasks();

    expect(isAgentSActive()).toBe(true);
    expect(history[0]?.status).toBe(StatusEnum.RUNNING);

    deferredFetch.resolve();

    const result = await loopPromise;

    expect(result.status).toBe(StatusEnum.END);
    expect(result.stepsExecuted).toBeGreaterThanOrEqual(1);
    expect(operator.execute).toHaveBeenCalledTimes(1);
    expect(history.some((state) => state.status === StatusEnum.END)).toBe(true);
    expect(isAgentSActive()).toBe(false);
  });

  it('keeps active false when sidecar preflight fails before the first turn', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator = createOperator();
    const unhealthyStatus = {
      state: 'unhealthy',
      mode: 'embedded',
      healthy: false,
      endpoint: null,
      pid: null,
      checkedAt: 1_000,
      lastHeartbeatAt: null,
      reason: 'health_http_error',
    } as const;
    const sidecarManager = {
      health: vi.fn(async () => ({ ...unhealthyStatus })),
      getStatus: vi.fn(() => ({ ...unhealthyStatus })),
    };

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'fail sidecar preflight',
      sessionHistoryMessages: [],
      deps: {
        fetch: failingFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_SIDECAR_UNHEALTHY');
    expect(result.error?.step).toBe(0);
    expect(operator.screenshot).not.toHaveBeenCalled();
    expect(operator.execute).not.toHaveBeenCalled();
    expect(history.map((state) => state.status)).toEqual([StatusEnum.ERROR]);
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      true,
    );
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

  it('returns runtime error state when provider config is missing before the first turn', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator = createOperator();
    const sidecarManager = createFakeSidecarManager();
    const invalidSettings = {
      ...createSettings(),
      vlmProvider: undefined,
    } satisfies LocalStore;

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: invalidSettings,
      operator,
      instruction: 'trigger missing provider config',
      sessionHistoryMessages: [],
      deps: {
        fetch: failingFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_TURN_REQUEST_FAILED');
    expect(result.error?.step).toBe(0);
    expect(result.error?.message).toContain(
      'Missing required Agent-S setting: vlmProvider',
    );
    expect(result.stepsExecuted).toBe(0);
    expect(sidecarManager.health).not.toHaveBeenCalled();
    expect(operator.screenshot).not.toHaveBeenCalled();
    expect(operator.execute).not.toHaveBeenCalled();
    expect(history.map((state) => state.status)).toEqual([StatusEnum.ERROR]);
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

  it('finishes with USER_STOPPED without timeout when pending predict is aborted', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator = createOperator();
    const sidecarManager = createFakeSidecarManager();
    const externalAbortController = new AbortController();

    setState({
      ...getState(),
      abortController: externalAbortController,
    });

    let capturedSignal: AbortSignal | null = null;
    let fetchAbortTriggered = false;
    let resolveStarted: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const pendingFetch: typeof fetch = async (_input, init) => {
      capturedSignal = init?.signal ?? null;
      resolveStarted();

      return await new Promise<Response>((_resolve, reject) => {
        if (!capturedSignal) {
          reject(new Error('missing abort signal'));
          return;
        }

        if (capturedSignal.aborted) {
          fetchAbortTriggered = true;
          reject(new Error('already aborted'));
          return;
        }

        capturedSignal.addEventListener(
          'abort',
          () => {
            fetchAbortTriggered = true;
            reject(new Error('predict aborted by controller'));
          },
          { once: true },
        );
      });
    };

    const loopPromise = runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'stop pending predict',
      sessionHistoryMessages: [],
      deps: {
        fetch: pendingFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    await fetchStarted;
    await flushMicrotasks();
    if (!capturedSignal) {
      throw new Error('expected runtime to provide fetch abort signal');
    }

    externalAbortController.abort();

    const result = await loopPromise;

    expect(fetchAbortTriggered).toBe(true);
    expect(result.status).toBe(StatusEnum.USER_STOPPED);
    expect(result.error).toBeUndefined();
    expect(result.error?.code).not.toBe('AGENT_S_TURN_TIMEOUT');
    expect(operator.execute).not.toHaveBeenCalled();
    expect(
      history.some((state) => state.status === StatusEnum.USER_STOPPED),
    ).toBe(true);
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      false,
    );
    expect(isAgentSActive()).toBe(false);
  });

  it('records USER_STOPPED when runtime abort controller cancels in-flight predict', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator = createOperator();
    const sidecarManager = createFakeSidecarManager();
    const abortController = new AbortController();

    setState({
      ...getState(),
      abortController,
    });

    let startedResolve: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    let capturedSignal: AbortSignal | null = null;
    const pendingFetch: typeof fetch = async (_input, init) => {
      capturedSignal = init?.signal ?? null;
      startedResolve();

      return await new Promise<Response>((_resolve, reject) => {
        const signal = capturedSignal;

        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }

        const abortError =
          typeof DOMException !== 'undefined'
            ? new DOMException('Aborted', 'AbortError')
            : new Error('aborted');

        const onAbort = () => {
          signal.removeEventListener('abort', onAbort);
          reject(abortError);
        };

        signal.addEventListener('abort', onAbort, { once: true });
      });
    };

    const loopPromise = runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'stop pending predict',
      sessionHistoryMessages: [],
      deps: {
        fetch: pendingFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    await startedPromise;
    abortController.abort();

    const result = await loopPromise;

    expect(result.status).toBe(StatusEnum.USER_STOPPED);
    expect(result.error).toBeUndefined();
    expect(operator.execute).not.toHaveBeenCalled();
    expect(
      history.some((state) => state.status === StatusEnum.USER_STOPPED),
    ).toBe(true);
    expect(isAgentSActive()).toBe(false);
  });

  it('waits for loopIntervalInMs before starting the next running step', async () => {
    const { setState, getState } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const timers = createTimerDeps();
    const operator: AgentSRuntimeOperator = {
      screenshot: vi
        .fn()
        .mockResolvedValue({ base64: 'ZmFrZQ==', scaleFactor: 1 }),
      execute: vi
        .fn()
        .mockResolvedValueOnce({ status: StatusEnum.RUNNING })
        .mockResolvedValueOnce({ status: StatusEnum.END }),
    };
    const predictFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(createPredictResponse('wait', 'keep going'));

    translateAgentSActionMock.mockReturnValue({
      ok: true,
      normalizedAction: 'wait',
      parsed: {
        action_type: 'wait',
        action_inputs: {},
        thought: '',
        reflection: null,
      },
    });

    const loopPromise = runAgentSRuntimeLoop({
      setState,
      getState,
      settings: {
        ...createSettings(),
        loopIntervalInMs: 250,
        agentSTurnTimeoutMs: 1_000,
      },
      operator,
      instruction: 'wait between steps',
      sessionHistoryMessages: [],
      deps: {
        fetch: predictFetch,
        sidecarManager,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        now: () => 1_234,
      },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (timers.scheduled.some((timer) => timer.ms === 250)) {
        break;
      }

      await flushMicrotasks();
    }

    const loopTimer = timers.scheduled.find((timer) => timer.ms === 250);

    expect(loopTimer).toBeDefined();
    expect(operator.screenshot).toHaveBeenCalledTimes(1);
    expect(operator.execute).toHaveBeenCalledTimes(1);
    expect(predictFetch).toHaveBeenCalledTimes(1);

    await flushMicrotasks();

    expect(operator.screenshot).toHaveBeenCalledTimes(1);
    expect(operator.execute).toHaveBeenCalledTimes(1);

    loopTimer?.callback();

    const result = await loopPromise;

    expect(result.status).toBe(StatusEnum.END);
    expect(result.stepsExecuted).toBe(2);
    expect(operator.screenshot).toHaveBeenCalledTimes(2);
    expect(operator.execute).toHaveBeenCalledTimes(2);
    expect(predictFetch).toHaveBeenCalledTimes(2);
  });

  it('returns immediately on terminal status without adding an extra loop delay', async () => {
    const { setState, getState } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const timers = createTimerDeps();
    const operator = createOperator();
    const predictFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(createPredictResponse('finished'));

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
      settings: {
        ...createSettings(),
        loopIntervalInMs: 250,
        agentSTurnTimeoutMs: 1_000,
      },
      operator,
      instruction: 'finish immediately',
      sessionHistoryMessages: [],
      deps: {
        fetch: predictFetch,
        sidecarManager,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.END);
    expect(result.stepsExecuted).toBe(1);
    expect(timers.scheduled.some((timer) => timer.ms === 250)).toBe(false);
  });
});
