/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusEnum } from '@ui-tars/shared/types';

const {
  settingStoreGetStoreMock,
  guiAgentCtorMock,
  guiAgentRunMock,
  utioSendInstructionMock,
  beforeAgentRunMock,
  afterAgentRunMock,
  getModelVersionMock,
  getSpByModelVersionMock,
  getLocalBrowserSearchEngineMock,
  defaultBrowserOperatorGetInstanceMock,
  remoteComputerCreateMock,
  createRemoteBrowserOperatorMock,
  getAuthHeaderMock,
  getRemoteVLMResponseApiSupportMock,
  getRemoteVLMProviderMock,
  checkBrowserAvailabilityMock,
  setAgentMock,
} = vi.hoisted(() => ({
  settingStoreGetStoreMock: vi.fn(),
  guiAgentCtorMock: vi.fn(),
  guiAgentRunMock: vi.fn(async () => undefined),
  utioSendInstructionMock: vi.fn(),
  beforeAgentRunMock: vi.fn(),
  afterAgentRunMock: vi.fn(),
  getModelVersionMock: vi.fn(() => 'ui-tars-1.5'),
  getSpByModelVersionMock: vi.fn(() => 'system-prompt'),
  getLocalBrowserSearchEngineMock: vi.fn(() => 'google'),
  defaultBrowserOperatorGetInstanceMock: vi.fn(async () => ({
    kind: 'local-browser-operator',
  })),
  remoteComputerCreateMock: vi.fn(async () => ({
    kind: 'remote-computer-operator',
  })),
  createRemoteBrowserOperatorMock: vi.fn(async () => ({
    kind: 'remote-browser-operator',
  })),
  getAuthHeaderMock: vi.fn(async () => ({
    Authorization: 'Bearer remote-token',
  })),
  getRemoteVLMResponseApiSupportMock: vi.fn(async () => true),
  getRemoteVLMProviderMock: vi.fn(async () => 'remote-provider'),
  checkBrowserAvailabilityMock: vi.fn(async () => undefined),
  setAgentMock: vi.fn(),
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
    create: remoteComputerCreateMock,
  },
  createRemoteBrowserOperator: createRemoteBrowserOperatorMock,
}));

vi.mock('@ui-tars/operator-browser', () => ({
  DefaultBrowserOperator: {
    getInstance: defaultBrowserOperatorGetInstanceMock,
  },
  RemoteBrowserOperator: class RemoteBrowserOperator {},
}));

vi.mock('@main/window/ScreenMarker', () => ({
  showPredictionMarker: vi.fn(),
}));

vi.mock('./browserCheck', () => ({
  checkBrowserAvailability: checkBrowserAvailabilityMock,
}));

vi.mock('../utils/agent', () => ({
  getModelVersion: getModelVersionMock,
  getSpByModelVersion: getSpByModelVersionMock,
  beforeAgentRun: beforeAgentRunMock,
  afterAgentRun: afterAgentRunMock,
  getLocalBrowserSearchEngine: getLocalBrowserSearchEngineMock,
}));

vi.mock('../remote/auth', () => ({
  getAuthHeader: getAuthHeaderMock,
}));

vi.mock('../remote/proxyClient', () => ({
  ProxyClient: {
    getRemoteVLMResponseApiSupport: getRemoteVLMResponseApiSupportMock,
    getRemoteVLMProvider: getRemoteVLMProviderMock,
  },
}));

vi.mock('../ipcRoutes/agent', () => ({
  GUIAgentManager: {
    getInstance: () => ({
      setAgent: setAgentMock,
    }),
  },
}));

vi.mock('./agentS/sidecarManager', () => ({
  classifyAgentSFailureReason: vi.fn(() => 'degraded_fallback'),
  agentSSidecarManager: {
    health: vi.fn(),
    setTelemetryCorrelation: vi.fn(),
    evaluateDispatchCircuit: vi.fn(),
    recordCircuitSuccess: vi.fn(),
    recordCircuitFailure: vi.fn(),
    getCircuitBreakerStatus: vi.fn(),
  },
}));

vi.mock('./agentS/telemetry', () => ({
  emitAgentSTelemetry: vi.fn(),
  sanitizeAgentSBoundaryPayload: <T>(value: T) => value,
  sanitizeAgentSPayload: <T>(value: T) => value,
}));

vi.mock('./agentS/runtimeLoop', () => ({
  runAgentSRuntimeLoop: vi.fn(),
}));

vi.mock('@main/utils/image', () => ({
  markClickPosition: vi.fn(async () => ''),
}));

vi.mock('@ui-tars/sdk', () => ({
  GUIAgent: function GUIAgentMock(
    this: { run: typeof guiAgentRunMock },
    config: unknown,
  ) {
    guiAgentCtorMock(config);
    this.run = guiAgentRunMock;
  },
}));

import {
  EngineMode,
  Operator,
  VLMConnectionMode,
  VLMProviderV2,
} from '@main/store/types';
import { FREE_MODEL_BASE_URL } from '../remote/shared';
import { runAgent } from './runAgent';

type RunAgentSetState = Parameters<typeof runAgent>[0];
type RunAgentGetState = Parameters<typeof runAgent>[1];

const createSettings = (
  overrides: Partial<ReturnType<typeof getDefaultSettings>> = {},
) => ({
  ...getDefaultSettings(),
  ...overrides,
});

const getDefaultSettings = () => ({
  language: 'en' as const,
  vlmConnectionMode: VLMConnectionMode.Managed,
  vlmProvider: VLMProviderV2.ui_tars_1_5,
  vlmBaseUrl: 'https://managed.example.com/v1',
  vlmApiKey: 'managed-api-key',
  vlmModelName: 'managed-model',
  useResponsesApi: false,
  maxLoopCount: 5,
  loopIntervalInMs: 100,
  searchEngineForBrowser: 'google',
  operator: Operator.LocalComputer,
  engineMode: EngineMode.UITARS,
});

const createStateHandlers = () => {
  let state = {
    theme: 'dark',
    ensurePermissions: {},
    instructions: 'open settings',
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

describe('legacy localhost runtime model selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingStoreGetStoreMock.mockReturnValue(createSettings());
  });

  it.each([Operator.LocalComputer, Operator.LocalBrowser])(
    'passes localhost OpenAI-compatible settings to GUIAgent for %s',
    async (operator) => {
      const { setState, getState } = createStateHandlers();
      settingStoreGetStoreMock.mockReturnValue(
        createSettings({
          operator,
          vlmConnectionMode: VLMConnectionMode.LocalhostOpenAICompatible,
          vlmBaseUrl: 'http://127.0.0.1:11434/v1',
          vlmApiKey: '',
          vlmModelName: 'ui-tars-local',
          useResponsesApi: true,
        }),
      );

      await runAgent(
        setState as unknown as RunAgentSetState,
        getState as unknown as RunAgentGetState,
      );

      expect(getModelVersionMock).toHaveBeenCalledWith(
        VLMProviderV2.ui_tars_1_5,
      );
      expect(getRemoteVLMResponseApiSupportMock).not.toHaveBeenCalled();
      expect(getRemoteVLMProviderMock).not.toHaveBeenCalled();
      expect(getAuthHeaderMock).not.toHaveBeenCalled();
      expect(guiAgentCtorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          model: {
            baseURL: 'http://127.0.0.1:11434/v1',
            apiKey: '', // secretlint-disable-line @secretlint/secretlint-rule-pattern -- intentionally empty for localhost runtime coverage
            model: 'ui-tars-local',
            useResponsesApi: true,
          },
          systemPrompt: 'system-prompt',
          uiTarsVersion: 'ui-tars-1.5',
        }),
      );
      expect(guiAgentRunMock).toHaveBeenCalledWith('open settings', [], {});

      if (operator === Operator.LocalBrowser) {
        expect(checkBrowserAvailabilityMock).toHaveBeenCalledTimes(1);
        expect(getLocalBrowserSearchEngineMock).toHaveBeenCalledWith('google');
        expect(defaultBrowserOperatorGetInstanceMock).toHaveBeenCalledWith(
          false,
          false,
          false,
          false,
          'google',
        );
      } else {
        expect(defaultBrowserOperatorGetInstanceMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each([Operator.RemoteComputer, Operator.RemoteBrowser])(
    'keeps remote overrides for %s even when localhost settings are saved',
    async (operator) => {
      const { setState, getState } = createStateHandlers();
      settingStoreGetStoreMock.mockReturnValue(
        createSettings({
          operator,
          vlmConnectionMode: VLMConnectionMode.LocalhostOpenAICompatible,
          vlmBaseUrl: 'http://127.0.0.1:11434/v1',
          vlmApiKey: '',
          vlmModelName: 'ui-tars-local',
          useResponsesApi: false,
        }),
      );

      await runAgent(
        setState as unknown as RunAgentSetState,
        getState as unknown as RunAgentGetState,
      );

      expect(getRemoteVLMResponseApiSupportMock).toHaveBeenCalledTimes(1);
      expect(getRemoteVLMProviderMock).toHaveBeenCalledTimes(1);
      expect(getAuthHeaderMock).toHaveBeenCalledTimes(1);
      expect(guiAgentCtorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          model: {
            baseURL: FREE_MODEL_BASE_URL,
            apiKey: '', // secretlint-disable-line @secretlint/secretlint-rule-pattern -- intentionally empty because remote flow does not use persisted localhost key
            model: '',
            useResponsesApi: true,
          },
          systemPrompt: 'system-prompt',
          uiTarsVersion: 'remote-provider',
        }),
      );
      expect(getSpByModelVersionMock).toHaveBeenCalledWith(
        'remote-provider',
        'en',
        operator === Operator.RemoteBrowser ? 'browser' : 'computer',
      );
      expect(guiAgentRunMock).toHaveBeenCalledWith('open settings', [], {
        Authorization: 'Bearer remote-token',
      });
    },
  );

  it('fails fast when Agent-S is paired with localhost mode', async () => {
    const { setState, getState } = createStateHandlers();
    settingStoreGetStoreMock.mockReturnValue(
      createSettings({
        engineMode: EngineMode.AgentS,
        operator: Operator.LocalComputer,
        vlmConnectionMode: VLMConnectionMode.LocalhostOpenAICompatible,
        vlmBaseUrl: 'http://127.0.0.1:11434/v1',
        vlmApiKey: '',
        vlmModelName: 'ui-tars-local',
        useResponsesApi: true,
      }),
    );

    await expect(
      runAgent(
        setState as unknown as RunAgentSetState,
        getState as unknown as RunAgentGetState,
      ),
    ).rejects.toThrow(/legacy UI-TARS local operators/);

    expect(guiAgentCtorMock).not.toHaveBeenCalled();
    expect(guiAgentRunMock).not.toHaveBeenCalled();
    expect(defaultBrowserOperatorGetInstanceMock).not.toHaveBeenCalled();
    expect(getRemoteVLMResponseApiSupportMock).not.toHaveBeenCalled();
    expect(getRemoteVLMProviderMock).not.toHaveBeenCalled();
    expect(getAuthHeaderMock).not.toHaveBeenCalled();
    expect(beforeAgentRunMock).not.toHaveBeenCalled();
    expect(afterAgentRunMock).not.toHaveBeenCalled();
  });
});
