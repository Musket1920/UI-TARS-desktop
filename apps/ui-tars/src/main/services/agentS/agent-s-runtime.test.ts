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
import type { SidecarStatus } from './sidecarManager';

const { translateAgentSActionMock } = vi.hoisted(() => ({
  translateAgentSActionMock: vi.fn(),
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

const createOperator = (): AgentSRuntimeOperator => ({
  screenshot: vi.fn(async () => ({
    base64: TINY_PNG_BASE64,
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

const createAbortablePendingFetch = () => {
  let startedResolve: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let capturedSignal: AbortSignal | null = null;

  const fetchMock: typeof fetch = async (_input, init) => {
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

  return {
    fetchMock,
    started,
    getSignal: () => capturedSignal,
  };
};

describe('agent-s-runtime runAgentSRuntimeLoop', () => {
  beforeEach(() => {
    translateAgentSActionMock.mockReset();
    setAgentSActive(false);
  });

  it('sets RUNNING and active only after sidecar preflight succeeds, then clears active after a successful run', async () => {
    const { setState: applyState, getState, history } = createStateHandlers();
    const runningVisibilitySnapshots: boolean[] = [];
    const setState = vi.fn((nextState: AppState) => {
      if (nextState.status === StatusEnum.RUNNING) {
        runningVisibilitySnapshots.push(isAgentSActive());
      }

      applyState(nextState);
    });
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

    expect(runningVisibilitySnapshots[0]).toBe(true);
    expect(isAgentSActive()).toBe(true);
    expect(history[0]?.status).toBe(StatusEnum.RUNNING);

    deferredFetch.resolve();

    const result = await loopPromise;

    expect(result.status).toBe(StatusEnum.END);
    expect(result.stepsExecuted).toBeGreaterThanOrEqual(1);
    expect(operator.execute).toHaveBeenCalledTimes(1);
    expect(operator.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        screenWidth: 1,
        screenHeight: 1,
      }),
    );
    expect(history.some((state) => state.status === StatusEnum.END)).toBe(true);
    expect(isAgentSActive()).toBe(false);
  });

  it('returns AGENT_S_SCREENSHOT_INVALID when screenshot data is not a valid PNG', async () => {
    const { setState, getState, history } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const operator: AgentSRuntimeOperator = {
      screenshot: vi.fn(async () => ({
        base64: 'ZmFrZQ==',
        scaleFactor: 1,
      })),
      execute: vi.fn(async () => ({
        status: StatusEnum.END,
      })),
    };
    const predictFetch = vi.fn<typeof fetch>();

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'reject invalid screenshot data',
      sessionHistoryMessages: [],
      deps: {
        fetch: predictFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_SCREENSHOT_INVALID');
    expect(result.error?.step).toBe(1);
    expect(result.error?.message).toBe(
      'Failed to decode screenshot dimensions for Agent-S turn',
    );
    expect(predictFetch).not.toHaveBeenCalled();
    expect(operator.execute).not.toHaveBeenCalled();
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      true,
    );
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

  it('continues past a transient preflight probe failure when the sidecar endpoint is still available', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator = createOperator();
    const sidecarManager = {
      health: vi.fn(
        async (): Promise<SidecarStatus> => ({
          state: 'unhealthy',
          mode: 'embedded',
          healthy: false,
          transientProbeFailure: true,
          endpoint: 'http://127.0.0.1:10800',
          pid: 4242,
          checkedAt: 1_000,
          lastHeartbeatAt: 900,
          reason: 'health_http_error',
        }),
      ),
      getStatus: vi.fn(
        (): SidecarStatus => ({
          state: 'running',
          mode: 'embedded',
          healthy: true,
          endpoint: 'http://127.0.0.1:10800',
          pid: 4242,
          checkedAt: 900,
          lastHeartbeatAt: 900,
        }),
      ),
    };
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
      settings: createSettings(),
      operator,
      instruction: 'ignore transient preflight probe failure',
      sessionHistoryMessages: [],
      deps: {
        fetch: predictFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.END);
    expect(result.error).toBeUndefined();
    expect(result.stepsExecuted).toBe(1);
    expect(operator.screenshot).toHaveBeenCalledTimes(1);
    expect(operator.execute).toHaveBeenCalledTimes(1);
    expect(predictFetch).toHaveBeenCalledTimes(1);
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      false,
    );
    expect(history.some((state) => state.status === StatusEnum.END)).toBe(true);
    expect(isAgentSActive()).toBe(false);
  });

  it('uses the latest live sidecar endpoint for each predict turn', async () => {
    const { setState, getState } = createStateHandlers();
    const operator: AgentSRuntimeOperator = {
      screenshot: vi
        .fn()
        .mockResolvedValue({ base64: TINY_PNG_BASE64, scaleFactor: 1 }),
      execute: vi
        .fn()
        .mockResolvedValueOnce({ status: StatusEnum.RUNNING })
        .mockResolvedValueOnce({ status: StatusEnum.END }),
    };
    const liveStatuses: SidecarStatus[] = [
      {
        state: 'running',
        mode: 'embedded',
        healthy: true,
        endpoint: 'http://127.0.0.1:10800',
        pid: 4242,
        checkedAt: 1_000,
        lastHeartbeatAt: 1_000,
      },
      {
        state: 'running',
        mode: 'embedded',
        healthy: true,
        endpoint: 'http://127.0.0.1:10900',
        pid: 4242,
        checkedAt: 1_100,
        lastHeartbeatAt: 1_100,
      },
    ];
    let liveStatusIndex = 0;
    const sidecarManager = {
      health: vi.fn(async () => ({ ...liveStatuses[0] })),
      getStatus: vi.fn(() => {
        const status =
          liveStatuses[Math.min(liveStatusIndex, liveStatuses.length - 1)];
        liveStatusIndex += 1;
        return { ...status };
      }),
    };
    const requestedUrls: string[] = [];
    const predictFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (input) => {
        requestedUrls.push(String(input));
        return createPredictResponse('wait', 'keep going');
      })
      .mockImplementationOnce(async (input) => {
        requestedUrls.push(String(input));
        return createPredictResponse('finished');
      });

    translateAgentSActionMock.mockImplementation((action: string) => ({
      ok: true,
      normalizedAction: action,
      parsed: {
        action_type: action,
        action_inputs: {},
        thought: '',
        reflection: null,
      },
    }));

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'follow the current sidecar endpoint',
      sessionHistoryMessages: [],
      deps: {
        fetch: predictFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.END);
    expect(result.stepsExecuted).toBe(2);
    expect(requestedUrls).toEqual([
      'http://127.0.0.1:10800/predict',
      'http://127.0.0.1:10900/predict',
    ]);
    expect(sidecarManager.getStatus).toHaveBeenCalledTimes(2);
  });

  it('fails cleanly when the live sidecar endpoint disappears between turns', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator: AgentSRuntimeOperator = {
      screenshot: vi
        .fn()
        .mockResolvedValue({ base64: TINY_PNG_BASE64, scaleFactor: 1 }),
      execute: vi.fn(async () => ({ status: StatusEnum.RUNNING })),
    };
    const liveStatuses: SidecarStatus[] = [
      {
        state: 'running',
        mode: 'embedded',
        healthy: true,
        endpoint: 'http://127.0.0.1:10800',
        pid: 4242,
        checkedAt: 1_000,
        lastHeartbeatAt: 1_000,
      },
      {
        state: 'stopped',
        mode: 'embedded',
        healthy: false,
        endpoint: null,
        pid: null,
        checkedAt: 1_100,
        lastHeartbeatAt: null,
        reason: 'stop_requested',
      },
    ];
    let liveStatusIndex = 0;
    const sidecarManager = {
      health: vi.fn(async () => ({ ...liveStatuses[0] })),
      getStatus: vi.fn(() => {
        const status =
          liveStatuses[Math.min(liveStatusIndex, liveStatuses.length - 1)];
        liveStatusIndex += 1;
        return { ...status };
      }),
    };
    const predictFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createPredictResponse('wait', 'keep going'));

    translateAgentSActionMock.mockImplementation((action: string) => ({
      ok: true,
      normalizedAction: action,
      parsed: {
        action_type: action,
        action_inputs: {},
        thought: '',
        reflection: null,
      },
    }));

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'stop when the sidecar disappears',
      sessionHistoryMessages: [],
      deps: {
        fetch: predictFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_SIDECAR_UNHEALTHY');
    expect(result.error?.step).toBe(2);
    expect(result.error?.sidecarReason).toBe('stop_requested');
    expect(predictFetch).toHaveBeenCalledTimes(1);
    expect(operator.execute).toHaveBeenCalledTimes(1);
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

  it('finishes with USER_STOPPED when a hanging screenshot is aborted', async () => {
    const { setState, getState, history } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const abortController = new AbortController();
    let resolveStarted: () => void = () => {};
    const screenshotStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const operator: AgentSRuntimeOperator = {
      screenshot: vi.fn(() => {
        resolveStarted();
        return new Promise<
          Awaited<ReturnType<AgentSRuntimeOperator['screenshot']>>
        >(() => {});
      }),
      execute: vi.fn(async () => ({
        status: StatusEnum.END,
      })),
    };

    setState({
      ...getState(),
      abortController,
    });

    const loopPromise = runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'stop hanging screenshot',
      sessionHistoryMessages: [],
      deps: {
        fetch: failingFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    await screenshotStarted;

    abortController.abort();

    const result = await loopPromise;

    expect(result.status).toBe(StatusEnum.USER_STOPPED);
    expect(result.error).toBeUndefined();
    expect(operator.execute).not.toHaveBeenCalled();
    expect(
      history.some((state) => state.status === StatusEnum.USER_STOPPED),
    ).toBe(true);
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      false,
    );
    expect(isAgentSActive()).toBe(false);
  });

  it('returns AGENT_S_OPERATOR_TIMEOUT when screenshot capture hangs past the turn timeout', async () => {
    const { setState, getState, history } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const timers = createTimerDeps();
    let resolveStarted: () => void = () => {};
    const screenshotStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const operator: AgentSRuntimeOperator = {
      screenshot: vi.fn(() => {
        resolveStarted();
        return new Promise<
          Awaited<ReturnType<AgentSRuntimeOperator['screenshot']>>
        >(() => {});
      }),
      execute: vi.fn(async () => ({
        status: StatusEnum.END,
      })),
    };

    const loopPromise = runAgentSRuntimeLoop({
      setState,
      getState,
      settings: {
        ...createSettings(),
        agentSTurnTimeoutMs: 1_000,
      },
      operator,
      instruction: 'timeout hanging screenshot',
      sessionHistoryMessages: [],
      deps: {
        fetch: failingFetch,
        sidecarManager,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        now: () => 1_234,
      },
    });

    await screenshotStarted;

    const timeoutTimer = [...timers.scheduled]
      .reverse()
      .find((timer) => timer.ms === 1_000 && !timer.cleared);

    expect(timeoutTimer).toBeDefined();

    timeoutTimer?.callback();

    const result = await loopPromise;

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_OPERATOR_TIMEOUT');
    expect(result.error?.message).toBe('Agent-S operator timed out in 1000ms');
    expect(result.error?.step).toBe(1);
    expect(operator.execute).not.toHaveBeenCalled();
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      true,
    );
    expect(isAgentSActive()).toBe(false);
  });

  it('returns AGENT_S_OPERATOR_ERROR when screenshot capture throws', async () => {
    const { setState, getState, history } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const operator: AgentSRuntimeOperator = {
      screenshot: vi.fn(async () => {
        throw new Error('screenshot exploded');
      }),
      execute: vi.fn(async () => ({
        status: StatusEnum.END,
      })),
    };
    const predictFetch = vi.fn<typeof fetch>();

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'trigger screenshot failure',
      sessionHistoryMessages: [],
      deps: {
        fetch: predictFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_OPERATOR_ERROR');
    expect(result.error?.message).toBe('screenshot exploded');
    expect(result.error?.step).toBe(1);
    expect(predictFetch).not.toHaveBeenCalled();
    expect(operator.execute).not.toHaveBeenCalled();
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      true,
    );
    expect(isAgentSActive()).toBe(false);
  });

  it('returns AGENT_S_OPERATOR_ERROR when operator execution throws', async () => {
    const { setState, getState, history } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const operator: AgentSRuntimeOperator = {
      screenshot: vi.fn(async () => ({
        base64: TINY_PNG_BASE64,
        scaleFactor: 1,
      })),
      execute: vi.fn(async () => {
        throw new Error('operator exploded');
      }),
    };
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
      settings: createSettings(),
      operator,
      instruction: 'trigger operator failure',
      sessionHistoryMessages: [],
      deps: {
        fetch: predictFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_OPERATOR_ERROR');
    expect(result.error?.message).toBe('operator exploded');
    expect(result.error?.step).toBe(1);
    expect(operator.execute).toHaveBeenCalledTimes(1);
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      true,
    );
    expect(isAgentSActive()).toBe(false);
  });

  it('finishes with USER_STOPPED when a hanging execute is aborted', async () => {
    const { setState, getState, history } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const abortController = new AbortController();
    let resolveStarted: () => void = () => {};
    const executeStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const operator: AgentSRuntimeOperator = {
      screenshot: vi.fn(async () => ({
        base64: TINY_PNG_BASE64,
        scaleFactor: 1,
      })),
      execute: vi.fn(() => {
        resolveStarted();
        return new Promise<
          Awaited<ReturnType<AgentSRuntimeOperator['execute']>>
        >(() => {});
      }),
    };
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

    setState({
      ...getState(),
      abortController,
    });

    const loopPromise = runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'stop hanging execute',
      sessionHistoryMessages: [],
      deps: {
        fetch: predictFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    await executeStarted;

    abortController.abort();

    const result = await loopPromise;

    expect(result.status).toBe(StatusEnum.USER_STOPPED);
    expect(result.error).toBeUndefined();
    expect(operator.execute).toHaveBeenCalledTimes(1);
    expect(
      history.some((state) => state.status === StatusEnum.USER_STOPPED),
    ).toBe(true);
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      false,
    );
    expect(isAgentSActive()).toBe(false);
  });

  it('returns AGENT_S_OPERATOR_TIMEOUT when execute hangs past the turn timeout', async () => {
    const { setState, getState, history } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const timers = createTimerDeps();
    let resolveStarted: () => void = () => {};
    const executeStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const operator: AgentSRuntimeOperator = {
      screenshot: vi.fn(async () => ({
        base64: TINY_PNG_BASE64,
        scaleFactor: 1,
      })),
      execute: vi.fn(() => {
        resolveStarted();
        return new Promise<
          Awaited<ReturnType<AgentSRuntimeOperator['execute']>>
        >(() => {});
      }),
    };
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

    const loopPromise = runAgentSRuntimeLoop({
      setState,
      getState,
      settings: {
        ...createSettings(),
        agentSTurnTimeoutMs: 1_000,
      },
      operator,
      instruction: 'timeout hanging execute',
      sessionHistoryMessages: [],
      deps: {
        fetch: predictFetch,
        sidecarManager,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        now: () => 1_234,
      },
    });

    await executeStarted;

    const timeoutTimer = [...timers.scheduled]
      .reverse()
      .find((timer) => timer.ms === 1_000 && !timer.cleared);

    expect(timeoutTimer).toBeDefined();

    timeoutTimer?.callback();

    const result = await loopPromise;

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_OPERATOR_TIMEOUT');
    expect(result.error?.message).toBe('Agent-S operator timed out in 1000ms');
    expect(result.error?.step).toBe(1);
    expect(operator.execute).toHaveBeenCalledTimes(1);
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      true,
    );
    expect(isAgentSActive()).toBe(false);
  });

  it('returns a dedicated config error state when provider config is missing before the first turn', async () => {
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
    expect(result.error?.code).toBe('AGENT_S_CONFIG_ERROR');
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

  it('returns the same dedicated config error when provider mapping is unsupported', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator = createOperator();
    const sidecarManager = createFakeSidecarManager();
    const invalidSettings = {
      ...createSettings(),
      vlmProvider: 'not-a-real-provider' as VLMProviderV2,
    } satisfies LocalStore;

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: invalidSettings,
      operator,
      instruction: 'trigger unsupported provider mapping',
      sessionHistoryMessages: [],
      deps: {
        fetch: failingFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_CONFIG_ERROR');
    expect(result.error?.step).toBe(0);
    expect(result.error?.message).toContain(
      'Unsupported Agent-S provider mapping for vlmProvider: not-a-real-provider',
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

  it('maps 4xx predict responses to AGENT_S_TURN_REQUEST_CLIENT_ERROR', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator = createOperator();
    const sidecarManager = createFakeSidecarManager();

    const clientErrorFetch: typeof fetch = async () =>
      ({
        ok: false,
        status: 422,
      }) as Response;

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'submit invalid sidecar request',
      sessionHistoryMessages: [],
      deps: {
        fetch: clientErrorFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_TURN_REQUEST_CLIENT_ERROR');
    expect(result.error?.step).toBe(1);
    expect(operator.execute).not.toHaveBeenCalled();
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      true,
    );
    expect(isAgentSActive()).toBe(false);
  });

  it('keeps 5xx predict responses on AGENT_S_TURN_REQUEST_FAILED', async () => {
    const { setState, getState, history } = createStateHandlers();
    const operator = createOperator();
    const sidecarManager = createFakeSidecarManager();

    const serverErrorFetch: typeof fetch = async () =>
      ({
        ok: false,
        status: 503,
      }) as Response;

    const result = await runAgentSRuntimeLoop({
      setState,
      getState,
      settings: createSettings(),
      operator,
      instruction: 'hit unavailable sidecar',
      sessionHistoryMessages: [],
      deps: {
        fetch: serverErrorFetch,
        sidecarManager,
        now: () => 1_234,
      },
    });

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_TURN_REQUEST_FAILED');
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

  it('classifies an in-flight predict as AGENT_S_TURN_TIMEOUT when no user abort is present', async () => {
    const { setState, getState, history } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const timers = createTimerDeps();
    const operator = createOperator();
    const pendingFetch = createAbortablePendingFetch();

    const loopPromise = runAgentSRuntimeLoop({
      setState,
      getState,
      settings: {
        ...createSettings(),
        agentSTurnTimeoutMs: 1_000,
      },
      operator,
      instruction: 'timeout pending predict',
      sessionHistoryMessages: [],
      deps: {
        fetch: pendingFetch.fetchMock,
        sidecarManager,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        now: () => 1_234,
      },
    });

    await pendingFetch.started;

    const timeoutTimer = timers.scheduled.find(
      (timer) => timer.ms === 1_000 && !timer.cleared,
    );

    expect(timeoutTimer).toBeDefined();
    expect(pendingFetch.getSignal()).not.toBeNull();

    timeoutTimer?.callback();

    const result = await loopPromise;

    expect(result.status).toBe(StatusEnum.ERROR);
    expect(result.error?.code).toBe('AGENT_S_TURN_TIMEOUT');
    expect(result.error?.step).toBe(1);
    expect(operator.execute).not.toHaveBeenCalled();
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      true,
    );
    expect(
      history.some((state) => state.status === StatusEnum.USER_STOPPED),
    ).toBe(false);
    expect(isAgentSActive()).toBe(false);
  });

  it('prefers USER_STOPPED when user abort races with turn timeout handling', async () => {
    const { setState, getState, history } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const timers = createTimerDeps();
    const operator = createOperator();
    const abortController = new AbortController();
    const pendingFetch = createAbortablePendingFetch();

    setState({
      ...getState(),
      abortController,
    });

    const loopPromise = runAgentSRuntimeLoop({
      setState,
      getState,
      settings: {
        ...createSettings(),
        agentSTurnTimeoutMs: 1_000,
      },
      operator,
      instruction: 'race timeout with user stop',
      sessionHistoryMessages: [],
      deps: {
        fetch: pendingFetch.fetchMock,
        sidecarManager,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        now: () => 1_234,
      },
    });

    await pendingFetch.started;

    const timeoutTimer = timers.scheduled.find(
      (timer) => timer.ms === 1_000 && !timer.cleared,
    );

    expect(timeoutTimer).toBeDefined();
    expect(pendingFetch.getSignal()).not.toBeNull();

    timeoutTimer?.callback();
    abortController.abort();

    const result = await loopPromise;

    expect(result.status).toBe(StatusEnum.USER_STOPPED);
    expect(result.error).toBeUndefined();
    expect(operator.execute).not.toHaveBeenCalled();
    expect(
      history.some((state) => state.status === StatusEnum.USER_STOPPED),
    ).toBe(true);
    expect(history.some((state) => state.status === StatusEnum.ERROR)).toBe(
      false,
    );
    expect(isAgentSActive()).toBe(false);
  });

  it('prefers USER_STOPPED when external abort is already set before timeout abort handling resolves', async () => {
    const { setState, getState, history } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const timers = createTimerDeps();
    const operator = createOperator();
    const abortController = new AbortController();

    setState({
      ...getState(),
      abortController,
    });

    let startedResolve: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    const pendingFetch: typeof fetch = async (_input, init) => {
      const signal = init?.signal;

      startedResolve();

      return await new Promise<Response>((_resolve, reject) => {
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
          void Promise.resolve().then(() => {
            reject(abortError);
          });
        };

        signal.addEventListener('abort', onAbort, { once: true });
      });
    };

    const loopPromise = runAgentSRuntimeLoop({
      setState,
      getState,
      settings: {
        ...createSettings(),
        agentSTurnTimeoutMs: 1_000,
      },
      operator,
      instruction: 'race timeout with already-aborted user stop',
      sessionHistoryMessages: [],
      deps: {
        fetch: pendingFetch,
        sidecarManager,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        now: () => 1_234,
      },
    });

    await started;

    const timeoutTimer = timers.scheduled.find(
      (timer) => timer.ms === 1_000 && !timer.cleared,
    );

    expect(timeoutTimer).toBeDefined();

    timeoutTimer?.callback();
    abortController.abort();

    const result = await loopPromise;

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

  it('waits for loopIntervalInMs before starting the next running step', async () => {
    const { setState, getState } = createStateHandlers();
    const sidecarManager = createFakeSidecarManager();
    const timers = createTimerDeps();
    const operator: AgentSRuntimeOperator = {
      screenshot: vi
        .fn()
        .mockResolvedValue({ base64: TINY_PNG_BASE64, scaleFactor: 1 }),
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

  it('uses the dedicated loop interval normalizer for runtime delays', async () => {
    vi.resetModules();
    const normalizeAgentSLoopIntervalMsMock = vi.fn((value: unknown) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(75, Math.floor(value));
      }

      return 1_000;
    });

    vi.doMock('@main/store/safetyPolicy', async () => {
      const actual = await vi.importActual<
        typeof import('@main/store/safetyPolicy')
      >('@main/store/safetyPolicy');

      return {
        ...actual,
        normalizeAgentSLoopIntervalMs: normalizeAgentSLoopIntervalMsMock,
      };
    });

    try {
      const { runAgentSRuntimeLoop: runAgentSRuntimeLoopWithMock } =
        await import('./runtimeLoop');
      const { setState, getState } = createStateHandlers();
      const sidecarManager = createFakeSidecarManager();
      const timers = createTimerDeps();
      const operator: AgentSRuntimeOperator = {
        screenshot: vi
          .fn()
          .mockResolvedValue({ base64: TINY_PNG_BASE64, scaleFactor: 1 }),
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

      const loopPromise = runAgentSRuntimeLoopWithMock({
        setState,
        getState,
        settings: {
          ...createSettings(),
          loopIntervalInMs: 25,
          agentSTurnTimeoutMs: 1_000,
        },
        operator,
        instruction: 'use dedicated loop interval floor',
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
        if (timers.scheduled.some((timer) => timer.ms === 75)) {
          break;
        }

        await flushMicrotasks();
      }

      const loopTimer = timers.scheduled.find((timer) => timer.ms === 75);

      expect(normalizeAgentSLoopIntervalMsMock).toHaveBeenCalledWith(25);
      expect(loopTimer).toBeDefined();
      expect(timers.scheduled.some((timer) => timer.ms === 50)).toBe(false);

      loopTimer?.callback();

      const result = await loopPromise;

      expect(result.status).toBe(StatusEnum.END);
      expect(result.stepsExecuted).toBe(2);
    } finally {
      vi.doUnmock('@main/store/safetyPolicy');
      vi.resetModules();
    }
  });
});
