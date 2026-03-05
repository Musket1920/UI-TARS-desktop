/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
type UnsafeSettings = {
  language: string;
  vlmBaseUrl: string;
  vlmApiKey: string;
  vlmModelName: string;
  operator: string;
  agentSEnableLocalEnv: boolean;
  maxLoopCount: number;
  loopIntervalInMs: number;
};

const getHandler = (name: string) => {
  const entry = ipcMainHandleMock.mock.calls.find((call) => call[0] === name);
  expect(entry).toBeTruthy();
  return entry?.[1] as RegisteredHandler;
};

const unsafeSettings: UnsafeSettings = {
  language: 'en',
  vlmBaseUrl: 'https://vlm.example.com',
  vlmApiKey: 'key',
  vlmModelName: 'model',
  operator: 'Local Computer Operator',
  agentSEnableLocalEnv: true,
  maxLoopCount: 999,
  loopIntervalInMs: 10_000,
};

const safeSettings: UnsafeSettings = {
  ...unsafeSettings,
  agentSEnableLocalEnv: false,
  maxLoopCount: 200,
  loopIntervalInMs: 3000,
};

describe('safety-defaults settings handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStoreMock.mockImplementation((settings) => {
      getStoreMock.mockReturnValue(settings);
    });
    registerSettingsHandlers(onSettingsUpdatedMock);
  });

  it('forces agentSEnableLocalEnv=false on setting:update', async () => {
    getStoreMock.mockReturnValue(safeSettings);
    const handler = getHandler('setting:update');

    await handler({}, unsafeSettings);

    expect(setStoreMock).toHaveBeenCalledTimes(1);
    expect(setStoreMock.mock.calls[0][0]).toMatchObject({
      agentSEnableLocalEnv: false,
      maxLoopCount: 200,
      loopIntervalInMs: 3000,
    });
    expect(onSettingsUpdatedMock).toHaveBeenCalledTimes(1);
    expect(onSettingsUpdatedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSEnableLocalEnv: false,
        maxLoopCount: 200,
        loopIntervalInMs: 3000,
      }),
    );
  });

  it('forces agentSEnableLocalEnv=false on preset imports', async () => {
    getStoreMock.mockReturnValue(safeSettings);
    importPresetFromTextMock.mockResolvedValue({ ...unsafeSettings });
    fetchPresetFromUrlMock.mockResolvedValue({ ...unsafeSettings });

    const importTextHandler = getHandler('setting:importPresetFromText');
    await importTextHandler({}, 'yaml-content');

    const importUrlHandler = getHandler('setting:importPresetFromUrl');
    await importUrlHandler({}, 'https://preset.example.com', true);

    expect(setStoreMock.mock.calls[0][0]).toMatchObject({
      agentSEnableLocalEnv: false,
    });
    expect(onSettingsUpdatedMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentSEnableLocalEnv: false,
      }),
    );
    expect(setStoreMock.mock.calls[1][0]).toMatchObject({
      agentSEnableLocalEnv: false,
      maxLoopCount: 200,
      loopIntervalInMs: 3000,
      presetSource: {
        type: 'remote',
        url: 'https://preset.example.com',
        autoUpdate: true,
      },
    });
    expect(onSettingsUpdatedMock).toHaveBeenCalledTimes(2);
  });

  it('forces safety policy bounds during remote preset refresh', async () => {
    getStoreMock.mockReturnValue({
      presetSource: {
        type: 'remote',
        url: 'https://preset.example.com',
        autoUpdate: true,
      },
    });
    fetchPresetFromUrlMock.mockResolvedValue({ ...unsafeSettings });

    const handler = getHandler('setting:updatePresetFromRemote');
    await handler({});

    expect(setStoreMock).toHaveBeenCalledTimes(1);
    expect(setStoreMock.mock.calls[0][0]).toMatchObject({
      agentSEnableLocalEnv: false,
      maxLoopCount: 200,
      loopIntervalInMs: 3000,
      presetSource: {
        type: 'remote',
        url: 'https://preset.example.com',
        autoUpdate: true,
      },
    });
    expect(onSettingsUpdatedMock).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows callback failures after settings mutation', async () => {
    const callbackError = new Error('callback failed');
    onSettingsUpdatedMock.mockRejectedValueOnce(callbackError);
    const handler = getHandler('setting:update');

    await expect(handler({}, unsafeSettings)).resolves.toBeUndefined();

    expect(setStoreMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Failed to handle settings update callback:',
      callbackError,
    );
  });
});
