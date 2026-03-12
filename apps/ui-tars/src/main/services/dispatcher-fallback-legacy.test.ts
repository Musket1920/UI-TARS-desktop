/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusEnum } from '@ui-tars/shared/types';

const {
  settingStoreGetStoreMock,
  sidecarHealthMock,
  sidecarSetTelemetryCorrelationMock,
  sidecarEvaluateDispatchCircuitMock,
  sidecarRecordCircuitSuccessMock,
  sidecarRecordCircuitFailureMock,
  sidecarGetCircuitBreakerStatusMock,
  runAgentSRuntimeLoopMock,
  emitAgentSTelemetryMock,
  guiAgentCtorMock,
  guiAgentRunMock,
  utioSendInstructionMock,
  beforeAgentRunMock,
  afterAgentRunMock,
} = vi.hoisted(() => ({
  settingStoreGetStoreMock: vi.fn(),
  sidecarHealthMock: vi.fn(),
  sidecarSetTelemetryCorrelationMock: vi.fn(),
  sidecarEvaluateDispatchCircuitMock: vi.fn(),
  sidecarRecordCircuitSuccessMock: vi.fn(),
  sidecarRecordCircuitFailureMock: vi.fn(),
  sidecarGetCircuitBreakerStatusMock: vi.fn(),
  runAgentSRuntimeLoopMock: vi.fn(),
  emitAgentSTelemetryMock: vi.fn(),
  guiAgentCtorMock: vi.fn(),
  guiAgentRunMock: vi.fn(async () => undefined),
  utioSendInstructionMock: vi.fn(),
  beforeAgentRunMock: vi.fn(),
  afterAgentRunMock: vi.fn(),
}));

vi.mock('@main/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock('@main/store/setting', () => ({
  SettingStore: {
    getStore: settingStoreGetStoreMock,
  },
}));

vi.mock('@main/services/utio', () => ({
  UTIOService: {
    getInstance: () => ({
      sendInstruction: utioSendInstructionMock,
    }),
  },
}));

vi.mock('../agent/operator', () => ({
  NutJSElectronOperator: class NutJSElectronOperator {},
}));

vi.mock('../remote/operators', () => ({
  RemoteComputerOperator: {
    create: vi.fn(async () => ({})),
  },
  createRemoteBrowserOperator: vi.fn(async () => ({})),
}));

vi.mock('@ui-tars/operator-browser', () => ({
  DefaultBrowserOperator: {
    getInstance: vi.fn(async () => ({})),
  },
  RemoteBrowserOperator: class RemoteBrowserOperator {},
}));

vi.mock('@main/window/ScreenMarker', () => ({
  showPredictionMarker: vi.fn(),
}));

vi.mock('./browserCheck', () => ({
  checkBrowserAvailability: vi.fn(async () => undefined),
}));

vi.mock('../utils/agent', () => ({
  getModelVersion: vi.fn(() => 'ui-tars-1.5'),
  getSpByModelVersion: vi.fn(() => 'system-prompt'),
  beforeAgentRun: beforeAgentRunMock,
  afterAgentRun: afterAgentRunMock,
  getLocalBrowserSearchEngine: vi.fn(() => 'google'),
}));

vi.mock('../remote/auth', () => ({
  getAuthHeader: vi.fn(async () => ({})),
}));

vi.mock('../remote/proxyClient', () => ({
  ProxyClient: {
    getRemoteVLMResponseApiSupport: vi.fn(async () => false),
    getRemoteVLMProvider: vi.fn(async () => 'ui-tars-1.5'),
  },
}));

vi.mock('../ipcRoutes/agent', () => ({
  GUIAgentManager: {
    getInstance: () => ({
      setAgent: vi.fn(),
    }),
  },
}));

vi.mock('./agentS/sidecarManager', () => ({
  classifyAgentSFailureReason: (reasonCode: string | null | undefined) => {
    if (!reasonCode) {
      return 'degraded_fallback';
    }
    if (reasonCode === 'AGENT_S_CONFIG_ERROR') {
      return 'degraded_fallback';
    }
    if (reasonCode === 'AGENT_S_PREDICTION_MALFORMED') {
      return 'invalid_output';
    }
    if (reasonCode === 'AGENT_S_TURN_TIMEOUT') {
      return 'timeout';
    }
    if (reasonCode === 'circuit_breaker_open') {
      return 'degraded_fallback';
    }
    return 'unavailable';
  },
  agentSSidecarManager: {
    health: sidecarHealthMock,
    setTelemetryCorrelation: sidecarSetTelemetryCorrelationMock,
    evaluateDispatchCircuit: sidecarEvaluateDispatchCircuitMock,
    recordCircuitSuccess: sidecarRecordCircuitSuccessMock,
    recordCircuitFailure: sidecarRecordCircuitFailureMock,
    getCircuitBreakerStatus: sidecarGetCircuitBreakerStatusMock,
  },
}));

vi.mock('./agentS/telemetry', () => ({
  emitAgentSTelemetry: emitAgentSTelemetryMock,
  sanitizeAgentSPayload: <T>(value: T) => value,
  sanitizeAgentSBoundaryPayload: <T>(value: T) => value,
}));

vi.mock('./agentS/runtimeLoop', () => ({
  runAgentSRuntimeLoop: runAgentSRuntimeLoopMock,
}));

vi.mock('@main/utils/image', () => ({
  markClickPosition: vi.fn(async () => ''),
}));

vi.mock('@ui-tars/sdk', () => ({
  GUIAgent: function GUIAgentMock(this: { run: typeof guiAgentRunMock }) {
    guiAgentCtorMock();
    this.run = guiAgentRunMock;
  },
}));

import { EngineMode, Operator, VLMProviderV2 } from '@main/store/types';
import { logger } from '@main/logger';
import { DefaultBrowserOperator } from '@ui-tars/operator-browser';
import { runAgent } from './runAgent';

type RunAgentSetState = Parameters<typeof runAgent>[0];
type RunAgentGetState = Parameters<typeof runAgent>[1];

const createAgentSSettings = () => ({
  language: 'en',
  vlmProvider: VLMProviderV2.ui_tars_1_5,
  vlmBaseUrl: 'https://vlm.example.com',
  vlmApiKey: 'secret',
  vlmModelName: 'ui-tars-1.5',
  useResponsesApi: false,
  maxLoopCount: 5,
  loopIntervalInMs: 100,
  searchEngineForBrowser: 'google',
  operator: Operator.LocalComputer,
  engineMode: EngineMode.AgentS,
});

const createStateHandlers = (
  overrides: Partial<ReturnType<typeof getDefaultState>> = {},
) => {
  let state = {
    ...getDefaultState(),
    ...overrides,
  };

  const setState = vi.fn((nextState) => {
    state = nextState;
  });

  return {
    setState,
    getState: vi.fn(() => state),
  };
};

const getDefaultState = () => ({
  theme: 'dark',
  ensurePermissions: {},
  instructions: 'fallback scenario',
  restUserData: null,
  status: StatusEnum.INIT,
  errorMsg: 'agent-s-error',
  sessionHistoryMessages: [],
  messages: [],
  abortController: null,
  thinking: false,
  agentSPaused: false,
  browserAvailable: true,
});

describe('dispatcher-fallback-legacy runAgent dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_S_DISPATCHER_FEATURE_FLAG;
    delete process.env.AGENT_S_FEATURE_FLAG;

    settingStoreGetStoreMock.mockReturnValue(createAgentSSettings());
    sidecarEvaluateDispatchCircuitMock.mockResolvedValue({
      allowAgentS: true,
      reasonCode: null,
      sidecarStatus: null,
      breaker: {
        state: 'closed',
        failureThreshold: 3,
        cooldownMs: 20_000,
        consecutiveFailures: 0,
        openedAt: null,
        nextProbeAt: null,
        canProbe: false,
        lastFailureAt: null,
        lastFailureCode: null,
        lastFailureClass: null,
        lastRecoveryAt: null,
      },
    });
    sidecarGetCircuitBreakerStatusMock.mockReturnValue({
      state: 'closed',
      failureThreshold: 3,
      cooldownMs: 20_000,
      consecutiveFailures: 0,
      openedAt: null,
      nextProbeAt: null,
      canProbe: false,
      lastFailureAt: null,
      lastFailureCode: null,
      lastFailureClass: null,
      lastRecoveryAt: null,
    });
    sidecarRecordCircuitFailureMock.mockReturnValue({
      state: 'closed',
      failureThreshold: 3,
      cooldownMs: 20_000,
      consecutiveFailures: 1,
      openedAt: null,
      nextProbeAt: null,
      canProbe: false,
      lastFailureAt: 100,
      lastFailureCode: 'health_http_error',
      lastFailureClass: 'unavailable',
      lastRecoveryAt: null,
    });
    sidecarRecordCircuitSuccessMock.mockReturnValue({
      state: 'closed',
      failureThreshold: 3,
      cooldownMs: 20_000,
      consecutiveFailures: 0,
      openedAt: null,
      nextProbeAt: null,
      canProbe: false,
      lastFailureAt: null,
      lastFailureCode: null,
      lastFailureClass: null,
      lastRecoveryAt: 100,
    });
  });

  afterEach(() => {
    delete process.env.AGENT_S_DISPATCHER_FEATURE_FLAG;
    delete process.env.AGENT_S_FEATURE_FLAG;
  });

  it('falls back to legacy path when Agent-S sidecar is unhealthy at dispatch time', async () => {
    const { setState, getState } = createStateHandlers();
    sidecarHealthMock.mockResolvedValue({
      state: 'unhealthy',
      mode: 'embedded',
      healthy: false,
      endpoint: 'http://127.0.0.1:10800',
      pid: null,
      checkedAt: 1_000,
      lastHeartbeatAt: null,
      reason: 'health_http_error',
    });

    await runAgent(
      setState as unknown as RunAgentSetState,
      getState as unknown as RunAgentGetState,
    );

    expect(sidecarHealthMock).toHaveBeenCalledWith({ probe: true });
    expect(runAgentSRuntimeLoopMock).not.toHaveBeenCalled();
    expect(guiAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(guiAgentRunMock).toHaveBeenCalledTimes(1);
    expect(utioSendInstructionMock).toHaveBeenCalledTimes(1);

    // Direct legacy fallback should have exactly one lifecycle pair
    expect(beforeAgentRunMock).toHaveBeenCalledTimes(1);
    expect(afterAgentRunMock).toHaveBeenCalledTimes(1);
    expect(beforeAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);
    expect(afterAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);

    const fallbackEvent = emitAgentSTelemetryMock.mock.calls.find(
      (call) =>
        call[0] === 'agent_s.fallback.triggered' &&
        call[1]?.source === 'agent_s.dispatcher',
    );

    expect(fallbackEvent?.[1]).toMatchObject({
      reasonCode: 'health_http_error',
      sidecarHealthy: false,
    });
    expect(sidecarRecordCircuitFailureMock).toHaveBeenCalledWith({
      source: 'dispatcher',
      reasonCode: 'health_http_error',
    });
  });

  it('falls back to legacy path when Agent-S sidecar probe throws', async () => {
    const { setState, getState } = createStateHandlers();
    sidecarHealthMock.mockRejectedValue(new Error('sidecar probe timeout'));

    await runAgent(
      setState as unknown as RunAgentSetState,
      getState as unknown as RunAgentGetState,
    );

    expect(runAgentSRuntimeLoopMock).not.toHaveBeenCalled();
    expect(guiAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(guiAgentRunMock).toHaveBeenCalledTimes(1);

    // Direct legacy fallback should have exactly one lifecycle pair
    expect(beforeAgentRunMock).toHaveBeenCalledTimes(1);
    expect(afterAgentRunMock).toHaveBeenCalledTimes(1);
    expect(beforeAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);
    expect(afterAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);

    const fallbackEvent = emitAgentSTelemetryMock.mock.calls.find(
      (call) =>
        call[0] === 'agent_s.fallback.triggered' &&
        call[1]?.source === 'agent_s.dispatcher',
    );

    expect(fallbackEvent?.[1]).toMatchObject({
      reasonCode: 'sidecar_health_probe_failed',
      sidecarHealthy: false,
      error: 'sidecar probe timeout',
    });
    expect(sidecarRecordCircuitFailureMock).toHaveBeenCalledWith({
      source: 'dispatcher',
      reasonCode: 'sidecar_health_probe_failed',
    });
  });

  it.each([
    ['ACTION_NOT_ALLOWED', 'action not allowed'],
    ['AGENT_S_TRANSLATION_FAILED', 'translation failed'],
    ['AGENT_S_PREDICTION_MALFORMED', 'malformed'],
  ])(
    'falls back to legacy path without recording circuit failure for %s runtime errors',
    async (reasonCode, message) => {
      const { setState, getState } = createStateHandlers();
      sidecarHealthMock.mockResolvedValue({
        state: 'running',
        mode: 'embedded',
        healthy: true,
        endpoint: 'http://127.0.0.1:10800',
        pid: 777,
        checkedAt: 1_000,
        lastHeartbeatAt: 1_000,
      });
      runAgentSRuntimeLoopMock.mockResolvedValue({
        status: StatusEnum.ERROR,
        stepsExecuted: 0,
        error: {
          code: reasonCode,
          message,
          step: 1,
        },
      });

      await runAgent(
        setState as unknown as RunAgentSetState,
        getState as unknown as RunAgentGetState,
      );

      expect(runAgentSRuntimeLoopMock).toHaveBeenCalledTimes(1);
      expect(guiAgentCtorMock).toHaveBeenCalledTimes(1);
      expect(guiAgentRunMock).toHaveBeenCalledTimes(1);
      expect(setState).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMsg: null,
        }),
      );

      // Agent-S attempted and failed, then fell back: exactly one lifecycle pair spanning both
      expect(beforeAgentRunMock).toHaveBeenCalledTimes(1);
      expect(afterAgentRunMock).toHaveBeenCalledTimes(1);
      expect(beforeAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);
      expect(afterAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);

      const fallbackEvent = emitAgentSTelemetryMock.mock.calls.find(
        (call) =>
          call[0] === 'agent_s.fallback.triggered' &&
          call[1]?.source === 'agent_s.dispatcher' &&
          call[1]?.reasonCode === reasonCode,
      );

      expect(fallbackEvent).toBeTruthy();
      expect(sidecarRecordCircuitFailureMock).not.toHaveBeenCalled();
    },
  );

  it('falls back to legacy path without recording circuit failure for 4xx runtime errors', async () => {
    const { setState, getState } = createStateHandlers();
    sidecarHealthMock.mockResolvedValue({
      state: 'running',
      mode: 'embedded',
      healthy: true,
      endpoint: 'http://127.0.0.1:10800',
      pid: 777,
      checkedAt: 1_000,
      lastHeartbeatAt: 1_000,
    });
    runAgentSRuntimeLoopMock.mockResolvedValue({
      status: StatusEnum.ERROR,
      stepsExecuted: 0,
      error: {
        code: 'AGENT_S_TURN_REQUEST_CLIENT_ERROR',
        message: 'client error',
        step: 1,
      },
    });

    await runAgent(
      setState as unknown as RunAgentSetState,
      getState as unknown as RunAgentGetState,
    );

    expect(runAgentSRuntimeLoopMock).toHaveBeenCalledTimes(1);
    expect(guiAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(guiAgentRunMock).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMsg: null,
      }),
    );

    const fallbackEvent = emitAgentSTelemetryMock.mock.calls.find(
      (call) =>
        call[0] === 'agent_s.fallback.triggered' &&
        call[1]?.source === 'agent_s.dispatcher' &&
        call[1]?.reasonCode === 'AGENT_S_TURN_REQUEST_CLIENT_ERROR',
    );

    expect(fallbackEvent).toBeTruthy();
    expect(sidecarRecordCircuitFailureMock).not.toHaveBeenCalled();
  });

  it('routes browser operator initialization failures through the guarded catch path', async () => {
    const { setState, getState } = createStateHandlers();
    settingStoreGetStoreMock.mockReturnValue({
      ...createAgentSSettings(),
      operator: Operator.LocalBrowser,
    });
    vi.mocked(DefaultBrowserOperator.getInstance).mockRejectedValueOnce(
      new Error('browser init failed'),
    );

    await expect(
      runAgent(
        setState as unknown as RunAgentSetState,
        getState as unknown as RunAgentGetState,
      ),
    ).rejects.toThrow('browser init failed');

    expect(sidecarEvaluateDispatchCircuitMock).not.toHaveBeenCalled();
    expect(beforeAgentRunMock).not.toHaveBeenCalled();
    expect(afterAgentRunMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      '[runAgent try-catch error]',
      expect.objectContaining({
        message: 'browser init failed',
      }),
    );
  });

  it('does not poison the circuit breaker when Agent-S runtime hits max steps', async () => {
    const { setState, getState } = createStateHandlers({
      status: StatusEnum.ERROR,
      errorMsg: 'stale runtime error',
    });
    sidecarHealthMock.mockResolvedValue({
      state: 'running',
      mode: 'embedded',
      healthy: true,
      endpoint: 'http://127.0.0.1:10800',
      pid: 777,
      checkedAt: 1_000,
      lastHeartbeatAt: 1_000,
    });
    runAgentSRuntimeLoopMock.mockResolvedValue({
      status: StatusEnum.ERROR,
      stepsExecuted: 5,
      error: {
        code: 'AGENT_S_MAX_STEPS_REACHED',
        message: 'max steps reached',
        step: 5,
      },
    });
    guiAgentRunMock.mockImplementationOnce(async () => {
      expect(getState()).toMatchObject({
        status: StatusEnum.RUNNING,
        errorMsg: null,
      });
    });

    await runAgent(
      setState as unknown as RunAgentSetState,
      getState as unknown as RunAgentGetState,
    );

    expect(runAgentSRuntimeLoopMock).toHaveBeenCalledTimes(1);
    expect(guiAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(guiAgentRunMock).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        errorMsg: null,
      }),
    );

    expect(beforeAgentRunMock).toHaveBeenCalledTimes(1);
    expect(afterAgentRunMock).toHaveBeenCalledTimes(1);
    expect(beforeAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);
    expect(afterAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);

    const fallbackEvent = emitAgentSTelemetryMock.mock.calls.find(
      (call) =>
        call[0] === 'agent_s.fallback.triggered' &&
        call[1]?.source === 'agent_s.dispatcher' &&
        call[1]?.reasonCode === 'AGENT_S_MAX_STEPS_REACHED',
    );

    expect(fallbackEvent?.[1]).toMatchObject({
      circuitBreakerState: 'closed',
      circuitConsecutiveFailures: 0,
      reasonCode: 'AGENT_S_MAX_STEPS_REACHED',
    });
    expect(sidecarRecordCircuitFailureMock).not.toHaveBeenCalled();
  });

  it('does not poison the circuit breaker when Agent-S runtime fails on provider config', async () => {
    const { setState, getState } = createStateHandlers({
      status: StatusEnum.ERROR,
      errorMsg: 'stale runtime error',
    });
    sidecarHealthMock.mockResolvedValue({
      state: 'running',
      mode: 'embedded',
      healthy: true,
      endpoint: 'http://127.0.0.1:10800',
      pid: 777,
      checkedAt: 1_000,
      lastHeartbeatAt: 1_000,
    });
    runAgentSRuntimeLoopMock.mockResolvedValue({
      status: StatusEnum.ERROR,
      stepsExecuted: 0,
      error: {
        code: 'AGENT_S_CONFIG_ERROR',
        message: 'Missing required Agent-S setting: vlmProvider',
        step: 0,
      },
    });
    guiAgentRunMock.mockImplementationOnce(async () => {
      expect(getState()).toMatchObject({
        status: StatusEnum.RUNNING,
        errorMsg: null,
      });
    });

    await runAgent(
      setState as unknown as RunAgentSetState,
      getState as unknown as RunAgentGetState,
    );

    expect(runAgentSRuntimeLoopMock).toHaveBeenCalledTimes(1);
    expect(guiAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(guiAgentRunMock).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        errorMsg: null,
      }),
    );

    const fallbackEvent = emitAgentSTelemetryMock.mock.calls.find(
      (call) =>
        call[0] === 'agent_s.fallback.triggered' &&
        call[1]?.source === 'agent_s.dispatcher' &&
        call[1]?.reasonCode === 'AGENT_S_CONFIG_ERROR',
    );

    expect(fallbackEvent?.[1]).toMatchObject({
      circuitBreakerState: 'closed',
      circuitConsecutiveFailures: 0,
      failureClass: 'degraded_fallback',
      reasonCode: 'AGENT_S_CONFIG_ERROR',
    });
    expect(sidecarRecordCircuitFailureMock).not.toHaveBeenCalled();
  });

  it('closes lifecycle once when legacy fallback setup throws after Agent-S attempt', async () => {
    const { setState, getState } = createStateHandlers();
    sidecarHealthMock.mockResolvedValue({
      state: 'running',
      mode: 'embedded',
      healthy: true,
      endpoint: 'http://127.0.0.1:10800',
      pid: 777,
      checkedAt: 1_000,
      lastHeartbeatAt: 1_000,
    });
    runAgentSRuntimeLoopMock.mockResolvedValue({
      status: StatusEnum.ERROR,
      stepsExecuted: 0,
      error: {
        code: 'AGENT_S_PREDICTION_MALFORMED',
        message: 'malformed',
        step: 1,
      },
    });
    guiAgentCtorMock.mockImplementationOnce(() => {
      throw new Error('legacy fallback setup failed');
    });

    await expect(
      runAgent(
        setState as unknown as RunAgentSetState,
        getState as unknown as RunAgentGetState,
      ),
    ).rejects.toThrow('legacy fallback setup failed');

    expect(runAgentSRuntimeLoopMock).toHaveBeenCalledTimes(1);
    expect(guiAgentCtorMock).toHaveBeenCalledTimes(1);
    expect(guiAgentRunMock).not.toHaveBeenCalled();

    expect(beforeAgentRunMock).toHaveBeenCalledTimes(1);
    expect(afterAgentRunMock).toHaveBeenCalledTimes(1);
    expect(beforeAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);
    expect(afterAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);
  });

  it('circuit-breaker-open bypasses Agent-S and routes directly to legacy', async () => {
    const { setState, getState } = createStateHandlers();
    sidecarGetCircuitBreakerStatusMock.mockReturnValueOnce({
      state: 'open',
      failureThreshold: 3,
      cooldownMs: 20_000,
      consecutiveFailures: 3,
      openedAt: 10,
      nextProbeAt: 20_010,
      canProbe: false,
      lastFailureAt: 10,
      lastFailureCode: 'AGENT_S_TURN_TIMEOUT',
      lastFailureClass: 'timeout',
      lastRecoveryAt: null,
    });
    sidecarEvaluateDispatchCircuitMock.mockResolvedValueOnce({
      allowAgentS: false,
      reasonCode: 'circuit_breaker_open',
      sidecarStatus: null,
      breaker: {
        state: 'open',
        failureThreshold: 3,
        cooldownMs: 20_000,
        consecutiveFailures: 3,
        openedAt: 10,
        nextProbeAt: 20_010,
        canProbe: false,
        lastFailureAt: 10,
        lastFailureCode: 'AGENT_S_TURN_TIMEOUT',
        lastFailureClass: 'timeout',
        lastRecoveryAt: null,
      },
    });

    await runAgent(
      setState as unknown as RunAgentSetState,
      getState as unknown as RunAgentGetState,
    );

    expect(runAgentSRuntimeLoopMock).not.toHaveBeenCalled();
    expect(guiAgentCtorMock).toHaveBeenCalledTimes(1);

    // Direct legacy fallback should have exactly one lifecycle pair
    expect(beforeAgentRunMock).toHaveBeenCalledTimes(1);
    expect(afterAgentRunMock).toHaveBeenCalledTimes(1);
    expect(beforeAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);
    expect(afterAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);

    const fallbackEvent = emitAgentSTelemetryMock.mock.calls.find(
      (call) =>
        call[0] === 'agent_s.fallback.triggered' &&
        call[1]?.source === 'agent_s.dispatcher' &&
        call[1]?.reasonCode === 'circuit_breaker_open',
    );

    expect(fallbackEvent?.[1]).toMatchObject({
      failureClass: 'degraded_fallback',
      circuitBreakerState: 'open',
    });
    expect(sidecarRecordCircuitFailureMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'dispatcher',
        reasonCode: 'circuit_breaker_open',
      }),
    );
  });

  it('circuit-breaker-recover allows Agent-S after cooldown probe closes breaker', async () => {
    const { setState, getState } = createStateHandlers();
    sidecarEvaluateDispatchCircuitMock.mockResolvedValueOnce({
      allowAgentS: true,
      reasonCode: 'circuit_breaker_recovered',
      sidecarStatus: {
        state: 'running',
        mode: 'embedded',
        healthy: true,
        endpoint: 'http://127.0.0.1:10800',
        pid: 700,
        checkedAt: 100,
        lastHeartbeatAt: 100,
      },
      breaker: {
        state: 'closed',
        failureThreshold: 3,
        cooldownMs: 20_000,
        consecutiveFailures: 0,
        openedAt: null,
        nextProbeAt: null,
        canProbe: false,
        lastFailureAt: null,
        lastFailureCode: null,
        lastFailureClass: null,
        lastRecoveryAt: 100,
      },
    });
    runAgentSRuntimeLoopMock.mockResolvedValueOnce({
      status: StatusEnum.END,
      stepsExecuted: 1,
    });

    await runAgent(
      setState as unknown as RunAgentSetState,
      getState as unknown as RunAgentGetState,
    );

    expect(runAgentSRuntimeLoopMock).toHaveBeenCalledTimes(1);
    expect(guiAgentCtorMock).not.toHaveBeenCalled();

    // Agent-S succeeded: exactly one lifecycle pair
    expect(beforeAgentRunMock).toHaveBeenCalledTimes(1);
    expect(afterAgentRunMock).toHaveBeenCalledTimes(1);
    expect(beforeAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);
    expect(afterAgentRunMock).toHaveBeenCalledWith(Operator.LocalComputer);

    expect(sidecarRecordCircuitSuccessMock).toHaveBeenCalledWith({
      source: 'runtime',
    });
  });

  it('circuit-breaker-recover keeps breaker open when cooldown probe fails', async () => {
    const { setState, getState } = createStateHandlers();
    sidecarGetCircuitBreakerStatusMock.mockReturnValueOnce({
      state: 'open',
      failureThreshold: 3,
      cooldownMs: 20_000,
      consecutiveFailures: 5,
      openedAt: 100,
      nextProbeAt: 20_100,
      canProbe: false,
      lastFailureAt: 777,
      lastFailureCode: 'health_http_error',
      lastFailureClass: 'unavailable',
      lastRecoveryAt: null,
    });
    sidecarEvaluateDispatchCircuitMock.mockResolvedValueOnce({
      allowAgentS: false,
      reasonCode: 'circuit_breaker_open',
      sidecarStatus: {
        state: 'unhealthy',
        mode: 'embedded',
        healthy: false,
        endpoint: 'http://127.0.0.1:10800',
        pid: null,
        checkedAt: 777,
        lastHeartbeatAt: null,
        reason: 'health_http_error',
      },
      breaker: {
        state: 'open',
        failureThreshold: 3,
        cooldownMs: 20_000,
        consecutiveFailures: 5,
        openedAt: 100,
        nextProbeAt: 20_100,
        canProbe: false,
        lastFailureAt: 777,
        lastFailureCode: 'health_http_error',
        lastFailureClass: 'unavailable',
        lastRecoveryAt: null,
      },
    });

    await runAgent(
      setState as unknown as RunAgentSetState,
      getState as unknown as RunAgentGetState,
    );

    expect(runAgentSRuntimeLoopMock).not.toHaveBeenCalled();
    expect(guiAgentCtorMock).toHaveBeenCalledTimes(1);

    const fallbackEvent = emitAgentSTelemetryMock.mock.calls.find(
      (call) =>
        call[0] === 'agent_s.fallback.triggered' &&
        call[1]?.source === 'agent_s.dispatcher' &&
        call[1]?.reasonCode === 'circuit_breaker_open',
    );

    expect(fallbackEvent?.[1]).toMatchObject({
      circuitBreakerState: 'open',
      failureClass: 'degraded_fallback',
      sidecarState: 'unhealthy',
    });
  });
});
