/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSSidecarMode,
  EngineMode,
  LocalStore,
  Operator,
} from '../store/types';

const {
  ipcMainHandleMock,
  setStoreMock,
  importPresetFromTextMock,
  fetchPresetFromUrlMock,
  getStoreMock,
  onSettingsUpdatedMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  ipcMainHandleMock: vi.fn(),
  setStoreMock: vi.fn(),
  importPresetFromTextMock: vi.fn(),
  fetchPresetFromUrlMock: vi.fn(),
  getStoreMock: vi.fn(() => ({})),
  onSettingsUpdatedMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcMainHandleMock,
  },
}));

vi.mock('../store/setting', () => ({
  SettingStore: {
    getStore: getStoreMock,
    clear: vi.fn(),
    getInstance: vi.fn(() => ({
      delete: vi.fn(),
    })),
    setStore: setStoreMock,
    importPresetFromText: importPresetFromTextMock,
    fetchPresetFromUrl: fetchPresetFromUrlMock,
  },
}));

vi.mock('../logger', () => ({
  logger: {
    error: loggerErrorMock,
  },
}));

import { registerSettingsHandlers } from './settings';

type RegisteredHandler = (...args: unknown[]) => Promise<void>;

const getHandler = (name: string) => {
  const entry = ipcMainHandleMock.mock.calls.find((call) => call[0] === name);
  expect(entry).toBeTruthy();
  return entry?.[1] as RegisteredHandler;
};

const createSettings = (overrides: Partial<LocalStore> = {}): LocalStore => ({
  language: 'en',
  vlmBaseUrl: 'https://vlm.example.com',
  vlmApiKey: 'key',
  vlmModelName: 'model',
  operator: Operator.LocalComputer,
  engineMode: EngineMode.UITARS,
  agentSSidecarMode: AgentSSidecarMode.Embedded,
  agentSSidecarUrl: 'https://embedded-sidecar.example.com',
  agentSSidecarPort: 11435,
  agentSEnableLocalEnv: false,
  maxLoopCount: 100,
  loopIntervalInMs: 1000,
  agentSTurnTimeoutMs: 1000,
  ...overrides,
});

const unsafeSettings = createSettings({
  agentSEnableLocalEnv: true,
  maxLoopCount: 999,
  loopIntervalInMs: 10_000,
  agentSTurnTimeoutMs: 10_000,
});

const safeSettings = createSettings({
  agentSEnableLocalEnv: false,
  maxLoopCount: 200,
  loopIntervalInMs: 3000,
  agentSTurnTimeoutMs: 3000,
});

describe('safety-defaults settings handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStoreMock.mockImplementation((settings) => {
      getStoreMock.mockReturnValue(settings);
    });
    registerSettingsHandlers(onSettingsUpdatedMock);
  });

  it('does not notify sidecar callback for unrelated setting changes', async () => {
    getStoreMock.mockReturnValue(safeSettings);
    const handler = getHandler('setting:update');

    await handler({}, unsafeSettings);

    expect(setStoreMock).toHaveBeenCalledTimes(1);
    expect(setStoreMock.mock.calls[0][0]).toMatchObject({
      agentSEnableLocalEnv: false,
      maxLoopCount: 200,
      loopIntervalInMs: 3000,
      agentSTurnTimeoutMs: 3000,
    });
    expect(onSettingsUpdatedMock).not.toHaveBeenCalled();
  });

  it('notifies sidecar callback when Agent-S lifecycle settings change', async () => {
    getStoreMock.mockReturnValue(safeSettings);
    const handler = getHandler('setting:update');

    await handler(
      {},
      createSettings({
        engineMode: EngineMode.AgentS,
        agentSSidecarMode: AgentSSidecarMode.Remote,
        agentSSidecarUrl: 'https://remote-sidecar.example.com',
        agentSSidecarPort: 4317,
        agentSEnableLocalEnv: true,
        maxLoopCount: 999,
        loopIntervalInMs: 10_000,
        agentSTurnTimeoutMs: 10_000,
      }),
    );

    expect(onSettingsUpdatedMock).toHaveBeenCalledTimes(1);
    expect(onSettingsUpdatedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        engineMode: EngineMode.AgentS,
        agentSSidecarMode: AgentSSidecarMode.Remote,
        agentSSidecarUrl: 'https://remote-sidecar.example.com',
        agentSSidecarPort: 4317,
        agentSEnableLocalEnv: false,
        maxLoopCount: 200,
        loopIntervalInMs: 3000,
        agentSTurnTimeoutMs: 3000,
      }),
    );
  });

  it('passes the latest safety-enforced settings to callback after preset import', async () => {
    getStoreMock.mockReturnValue(safeSettings);
    importPresetFromTextMock.mockResolvedValue(
      createSettings({
        engineMode: EngineMode.AgentS,
        agentSSidecarMode: AgentSSidecarMode.Remote,
        agentSSidecarUrl: 'https://imported-sidecar.example.com',
        agentSSidecarPort: 8443,
        agentSEnableLocalEnv: true,
        maxLoopCount: 999,
        loopIntervalInMs: 10_000,
        agentSTurnTimeoutMs: 10_000,
      }),
    );

    const handler = getHandler('setting:importPresetFromText');
    await handler({}, 'yaml-content');

    expect(setStoreMock).toHaveBeenCalledTimes(1);
    expect(setStoreMock.mock.calls[0][0]).toMatchObject({
      engineMode: EngineMode.AgentS,
      agentSSidecarMode: AgentSSidecarMode.Remote,
      agentSSidecarUrl: 'https://imported-sidecar.example.com',
      agentSSidecarPort: 8443,
      agentSEnableLocalEnv: false,
      maxLoopCount: 200,
      loopIntervalInMs: 3000,
      agentSTurnTimeoutMs: 3000,
    });
    expect(onSettingsUpdatedMock).toHaveBeenCalledTimes(1);
    expect(onSettingsUpdatedMock).toHaveBeenCalledWith(
      setStoreMock.mock.calls[0][0],
    );
  });

  it('logs and swallows callback failures after settings mutation', async () => {
    const callbackError = new Error('callback failed');
    onSettingsUpdatedMock.mockRejectedValueOnce(callbackError);
    const handler = getHandler('setting:update');

    await expect(
      handler(
        {},
        createSettings({
          engineMode: EngineMode.AgentS,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(setStoreMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Failed to handle settings update callback:',
      callbackError,
    );
  });
});
