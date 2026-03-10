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
    if (reasonCode === 'AGENT_S_PREDICTION_MALFORMED') {
      return 'invalid_output';
    }
    if (
      reasonCode === 'AGENT_S_TURN_TIMEOUT' ||
      reasonCode === 'AGENT_S_OPERATOR_TIMEOUT'
    ) {
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

const createStateHandlers = () => {
  let state = {
    theme: 'dark',
    ensurePermissions: {},
    instructions: 'run with agent-s',
    restUserData: null,
    status: StatusEnum.INIT,
    errorMsg: null,
    sessionHistoryMessages: [],
    messages: [],
    abortController: null,
    thinking: false,
    agentSPaused: false,
    browserAvailable: true,
  };

  return {
    setState: vi.fn((nextState) => {
      state = nextState;
    }),
    getState: vi.fn(() => state),
  };
};

describe('dispatcher-agent-s-selected runAgent dispatcher', () => {
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
    sidecarHealthMock.mockResolvedValue({
      state: 'running',
      mode: 'embedded',
      healthy: true,
      endpoint: 'http://127.0.0.1:10800',
      pid: 999,
      checkedAt: 1_000,
      lastHeartbeatAt: 1_000,
    });
    runAgentSRuntimeLoopMock.mockResolvedValue({
      status: StatusEnum.END,
      stepsExecuted: 1,
    });
  });

  afterEach(() => {
    delete process.env.AGENT_S_DISPATCHER_FEATURE_FLAG;
    delete process.env.AGENT_S_FEATURE_FLAG;
  });

  it('selects Agent-S runtime only when sidecar is healthy', async () => {
    const { setState, getState } = createStateHandlers();

    await runAgent(
      setState as unknown as RunAgentSetState,
      getState as unknown as RunAgentGetState,
    );

    expect(sidecarHealthMock).toHaveBeenCalledWith({ probe: true });
    expect(runAgentSRuntimeLoopMock).toHaveBeenCalledTimes(1);
    expect(guiAgentCtorMock).not.toHaveBeenCalled();
    expect(guiAgentRunMock).not.toHaveBeenCalled();
    expect(utioSendInstructionMock).not.toHaveBeenCalled();
    expect(sidecarRecordCircuitSuccessMock).toHaveBeenCalledTimes(1);
    expect(beforeAgentRunMock).toHaveBeenCalledTimes(1);
    expect(afterAgentRunMock).toHaveBeenCalledTimes(1);

    const engineSelectedEvent = emitAgentSTelemetryMock.mock.calls.find(
      (call) => call[0] === 'agent_s.engine.selected',
    );

    expect(engineSelectedEvent?.[1]).toMatchObject({
      selectedRuntime: 'agent_s',
      sidecarHealthy: true,
      featureEnabled: true,
    });
  });

  it.each([
    ['AGENT_S_OPERATOR_ERROR', 'operator exploded'],
    ['AGENT_S_OPERATOR_TIMEOUT', 'operator timed out'],
  ])(
    'does not record breaker failures for %s runtime fallback',
    async (errorCode, message) => {
      const { setState, getState } = createStateHandlers();

      runAgentSRuntimeLoopMock.mockResolvedValueOnce({
        status: StatusEnum.ERROR,
        stepsExecuted: 1,
        error: {
          code: errorCode,
          message,
          step: 1,
        },
      });

      await runAgent(
        setState as unknown as RunAgentSetState,
        getState as unknown as RunAgentGetState,
      );

      expect(runAgentSRuntimeLoopMock).toHaveBeenCalledTimes(1);
      expect(sidecarRecordCircuitFailureMock).not.toHaveBeenCalled();
      expect(guiAgentCtorMock).toHaveBeenCalledTimes(1);
      expect(guiAgentRunMock).toHaveBeenCalledTimes(1);
      expect(beforeAgentRunMock).toHaveBeenCalledTimes(1);
      expect(afterAgentRunMock).toHaveBeenCalledTimes(1);
    },
  );
});
