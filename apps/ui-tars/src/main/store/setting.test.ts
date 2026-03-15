/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_S_SAFE_DEFAULT_LOOP_INTERVAL_MS,
  AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS,
  AGENT_S_SAFE_MIN_LOOP_INTERVAL_MS,
  AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
} from './safetyPolicy';
import {
  AgentSSidecarMode,
  EngineMode,
  LocalStore,
  Operator,
  VLMConnectionMode,
  VLMProviderV2,
} from './types';

const {
  electronStoreSetMock,
  browserWindowSendMock,
  onDidAnyChangeHandlerRef,
} = vi.hoisted(() => ({
  electronStoreSetMock: vi.fn(),
  browserWindowSendMock: vi.fn(),
  onDidAnyChangeHandlerRef: {
    current: undefined as
      | ((newValue: LocalStore, oldValue: LocalStore) => void)
      | undefined,
  },
}));

vi.mock('@main/env', () => ({
  vlmProvider: '',
  vlmBaseUrl: '',
  vlmApiKey: '',
  vlmModelName: '',
}));

vi.mock('@main/logger', () => ({
  logger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@main/services/agentS/telemetry', () => ({
  sanitizeAgentSPayload: vi.fn((payload: unknown) => payload),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        webContents: {
          send: browserWindowSendMock,
        },
      },
    ]),
  },
}));

vi.mock('electron-store', () => ({
  default: class MockElectronStore {
    public store = {} as LocalStore;

    public onDidAnyChange(
      listener: (newValue: LocalStore, oldValue: LocalStore) => void,
    ): void {
      onDidAnyChangeHandlerRef.current = listener;
    }

    public set = electronStoreSetMock;

    public get(): undefined {
      return undefined;
    }

    public delete(): void {}

    public openInEditor(): void {}
  },
}));

const createSettings = (overrides: Partial<LocalStore> = {}): LocalStore => ({
  language: 'en',
  vlmConnectionMode: VLMConnectionMode.Managed,
  vlmProvider: VLMProviderV2.ui_tars_1_5,
  vlmBaseUrl: 'https://vlm.example.com',
  vlmApiKey: 'key',
  vlmModelName: 'model',
  useResponsesApi: false,
  operator: Operator.LocalComputer,
  engineMode: EngineMode.UITARS,
  agentSSidecarMode: AgentSSidecarMode.Embedded,
  agentSEnableLocalEnv: false,
  maxLoopCount: 100,
  loopIntervalInMs: AGENT_S_SAFE_DEFAULT_LOOP_INTERVAL_MS,
  agentSTurnTimeoutMs: AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS,
  ...overrides,
});

describe('SettingStore', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    onDidAnyChangeHandlerRef.current = undefined;
  });

  it('rewrites unsafe persisted Agent-S turn timeouts to the safe value', async () => {
    const { SettingStore } = await import('./setting');

    SettingStore.getInstance();

    expect(onDidAnyChangeHandlerRef.current).toBeTypeOf('function');

    const previousValue = createSettings();
    const unsafeValue = createSettings({
      agentSTurnTimeoutMs: AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS + 1,
    });

    onDidAnyChangeHandlerRef.current?.(unsafeValue, previousValue);

    expect(electronStoreSetMock).toHaveBeenCalledTimes(1);
    expect(electronStoreSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSTurnTimeoutMs: AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
      }),
    );
    expect(browserWindowSendMock).not.toHaveBeenCalled();
  });

  it('persists managed defaults for manual localhost-capable settings', async () => {
    const { DEFAULT_SETTING } = await import('./setting');

    expect(DEFAULT_SETTING.vlmConnectionMode).toBe(VLMConnectionMode.Managed);
    expect(DEFAULT_SETTING.vlmProvider).toBe('');
    expect(DEFAULT_SETTING.vlmBaseUrl).toBe('');
    expect(DEFAULT_SETTING.vlmApiKey).toBe('');
    expect(DEFAULT_SETTING.vlmModelName).toBe('');
    expect(DEFAULT_SETTING.useResponsesApi).toBe(false);
  });

  it('accepts the default managed store through setStore', async () => {
    const { DEFAULT_SETTING, SettingStore } = await import('./setting');

    expect(() => SettingStore.setStore(DEFAULT_SETTING)).not.toThrow();
    expect(electronStoreSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ...DEFAULT_SETTING,
        agentSTurnTimeoutMs: AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS,
      }),
    );
  });

  it('rewrites unsafe persisted Agent-S loop intervals to the dedicated safe floor', async () => {
    const { SettingStore } = await import('./setting');

    SettingStore.getInstance();

    expect(onDidAnyChangeHandlerRef.current).toBeTypeOf('function');

    const previousValue = createSettings();
    const unsafeValue = createSettings({
      loopIntervalInMs: AGENT_S_SAFE_MIN_LOOP_INTERVAL_MS - 1,
    });

    onDidAnyChangeHandlerRef.current?.(unsafeValue, previousValue);

    expect(electronStoreSetMock).toHaveBeenCalledTimes(1);
    expect(electronStoreSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        loopIntervalInMs: AGENT_S_SAFE_MIN_LOOP_INTERVAL_MS,
      }),
    );
    expect(browserWindowSendMock).not.toHaveBeenCalled();
  });

  it('hydrates imported presets back into managed settings', async () => {
    const { SettingStore } = await import('./setting');

    const settings = await SettingStore.importPresetFromText(`
vlmBaseUrl: https://vlm.example.com
vlmApiKey: preset-key
vlmModelName: preset-model
vlmProvider: ${VLMProviderV2.ui_tars_1_5}
useResponsesApi: true
operator: ${Operator.LocalComputer}
`);

    expect(settings.vlmConnectionMode).toBe(VLMConnectionMode.Managed);
    expect(settings.vlmProvider).toBe(VLMProviderV2.ui_tars_1_5);
    expect(settings.vlmApiKey).toBe('preset-key');
    expect(settings.vlmModelName).toBe('preset-model');
    expect(settings.useResponsesApi).toBe(true);
  });

  it('rejects invalid localhost combinations before persisting full store state', async () => {
    const { SettingStore } = await import('./setting');

    expect(() =>
      SettingStore.setStore(
        createSettings({
          operator: Operator.RemoteComputer,
          vlmConnectionMode: VLMConnectionMode.LocalhostOpenAICompatible,
          vlmBaseUrl: 'http://127.0.0.1:11434/v1',
          vlmApiKey: '',
          vlmModelName: 'ui-tars-1.5-7b',
        }),
      ),
    ).toThrow(/legacy UI-TARS local operators/);
    expect(electronStoreSetMock).not.toHaveBeenCalled();
  });
});
