/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_S_SAFE_DEFAULT_LOOP_INTERVAL_MS,
  AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS,
  AGENT_S_SAFE_MAX_LOOP_INTERVAL_MS,
  AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
} from '../store/safetyPolicy';
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

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject,
  };
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
  loopIntervalInMs: AGENT_S_SAFE_DEFAULT_LOOP_INTERVAL_MS,
  agentSTurnTimeoutMs: AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS,
  ...overrides,
});

const unsafeSettings = createSettings({
  agentSEnableLocalEnv: true,
  maxLoopCount: 999,
  loopIntervalInMs: 10_000,
  agentSTurnTimeoutMs: 60_000,
});

const safeSettings = createSettings({
  agentSEnableLocalEnv: false,
  maxLoopCount: 200,
  loopIntervalInMs: AGENT_S_SAFE_MAX_LOOP_INTERVAL_MS,
  agentSTurnTimeoutMs: AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
});

describe('Agent-S timeout safety constants', () => {
  it('keeps real Agent-S turns above three seconds by default', () => {
    expect(AGENT_S_SAFE_DEFAULT_LOOP_INTERVAL_MS).toBe(1_000);
    expect(AGENT_S_SAFE_MAX_LOOP_INTERVAL_MS).toBe(3_000);
    expect(AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS).toBe(10_000);
    expect(AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS).toBe(30_000);
  });
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
      loopIntervalInMs: AGENT_S_SAFE_MAX_LOOP_INTERVAL_MS,
      agentSTurnTimeoutMs: AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
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
        agentSTurnTimeoutMs: 60_000,
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
        loopIntervalInMs: AGENT_S_SAFE_MAX_LOOP_INTERVAL_MS,
        agentSTurnTimeoutMs: AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
      }),
    );
  });

  it('does not await sidecar callback when Agent-S lifecycle settings change', async () => {
    const callbackDeferred = createDeferred<void>();
    let callbackSettled = false;

    callbackDeferred.promise.finally(() => {
      callbackSettled = true;
    });
    onSettingsUpdatedMock.mockImplementation(() => callbackDeferred.promise);
    getStoreMock.mockReturnValue(safeSettings);

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
    expect(onSettingsUpdatedMock).toHaveBeenCalledTimes(1);
    expect(onSettingsUpdatedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        engineMode: EngineMode.AgentS,
      }),
    );
    expect(callbackSettled).toBe(false);

    callbackDeferred.resolve();
    await callbackDeferred.promise;
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
        agentSTurnTimeoutMs: 60_000,
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
      loopIntervalInMs: AGENT_S_SAFE_MAX_LOOP_INTERVAL_MS,
      agentSTurnTimeoutMs: AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
    });
    expect(onSettingsUpdatedMock).toHaveBeenCalledTimes(1);
    expect(onSettingsUpdatedMock).toHaveBeenCalledWith(
      setStoreMock.mock.calls[0][0],
    );
  });

  it('does not await sidecar callback during text preset import', async () => {
    const callbackDeferred = createDeferred<void>();
    let callbackSettled = false;

    callbackDeferred.promise.finally(() => {
      callbackSettled = true;
    });
    onSettingsUpdatedMock.mockImplementation(() => callbackDeferred.promise);
    getStoreMock.mockReturnValue(safeSettings);
    importPresetFromTextMock.mockResolvedValue(
      createSettings({
        engineMode: EngineMode.AgentS,
        agentSSidecarMode: AgentSSidecarMode.Remote,
        agentSSidecarUrl: 'https://imported-sidecar.example.com',
        agentSSidecarPort: 8443,
      }),
    );

    const handler = getHandler('setting:importPresetFromText');

    await expect(handler({}, 'yaml-content')).resolves.toBeUndefined();

    expect(setStoreMock).toHaveBeenCalledTimes(1);
    expect(onSettingsUpdatedMock).toHaveBeenCalledTimes(1);
    expect(onSettingsUpdatedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        engineMode: EngineMode.AgentS,
        agentSSidecarMode: AgentSSidecarMode.Remote,
        agentSSidecarUrl: 'https://imported-sidecar.example.com',
        agentSSidecarPort: 8443,
      }),
    );
    expect(callbackSettled).toBe(false);

    callbackDeferred.resolve();
    await callbackDeferred.promise;
  });

  it('does not await sidecar callback during remote preset import', async () => {
    const callbackDeferred = createDeferred<void>();
    let callbackSettled = false;

    callbackDeferred.promise.finally(() => {
      callbackSettled = true;
    });
    onSettingsUpdatedMock.mockImplementation(() => callbackDeferred.promise);
    getStoreMock.mockReturnValue(safeSettings);
    fetchPresetFromUrlMock.mockResolvedValue(
      createSettings({
        engineMode: EngineMode.AgentS,
        agentSSidecarMode: AgentSSidecarMode.Remote,
        agentSSidecarUrl: 'https://remote-imported-sidecar.example.com',
        agentSSidecarPort: 4317,
      }),
    );

    const handler = getHandler('setting:importPresetFromUrl');

    await expect(
      handler({}, 'https://preset.example.com', true),
    ).resolves.toBeUndefined();

    expect(setStoreMock).toHaveBeenCalledTimes(1);
    expect(onSettingsUpdatedMock).toHaveBeenCalledTimes(1);
    expect(onSettingsUpdatedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        engineMode: EngineMode.AgentS,
        agentSSidecarMode: AgentSSidecarMode.Remote,
        agentSSidecarUrl: 'https://remote-imported-sidecar.example.com',
        agentSSidecarPort: 4317,
      }),
    );
    expect(callbackSettled).toBe(false);

    callbackDeferred.resolve();
    await callbackDeferred.promise;
  });

  it('does not await sidecar callback during remote preset refresh', async () => {
    const callbackDeferred = createDeferred<void>();
    let callbackSettled = false;

    callbackDeferred.promise.finally(() => {
      callbackSettled = true;
    });
    onSettingsUpdatedMock.mockImplementation(() => callbackDeferred.promise);
    getStoreMock.mockReturnValue(
      createSettings({
        presetSource: {
          type: 'remote',
          url: 'https://preset.example.com',
          autoUpdate: true,
          lastUpdated: 1,
        },
      }),
    );
    fetchPresetFromUrlMock.mockResolvedValue(
      createSettings({
        engineMode: EngineMode.AgentS,
        agentSSidecarMode: AgentSSidecarMode.Remote,
        agentSSidecarUrl: 'https://refreshed-sidecar.example.com',
        agentSSidecarPort: 8443,
      }),
    );

    const handler = getHandler('setting:updatePresetFromRemote');

    await expect(handler({})).resolves.toBeUndefined();

    expect(setStoreMock).toHaveBeenCalledTimes(1);
    expect(onSettingsUpdatedMock).toHaveBeenCalledTimes(1);
    expect(onSettingsUpdatedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        engineMode: EngineMode.AgentS,
        agentSSidecarMode: AgentSSidecarMode.Remote,
        agentSSidecarUrl: 'https://refreshed-sidecar.example.com',
        agentSSidecarPort: 8443,
      }),
    );
    expect(callbackSettled).toBe(false);

    callbackDeferred.resolve();
    await callbackDeferred.promise;
  });

  it('logs and swallows async callback failures after settings mutation', async () => {
    const callbackError = new Error('callback failed');
    const callbackDeferred = createDeferred<void>();

    onSettingsUpdatedMock.mockImplementation(() => callbackDeferred.promise);
    const handler = getHandler('setting:update');

    await expect(
      handler(
        {},
        createSettings({
          engineMode: EngineMode.AgentS,
        }),
      ),
    ).resolves.toBeUndefined();

    callbackDeferred.reject(callbackError);
    await Promise.resolve();
    await Promise.resolve();

    expect(setStoreMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Failed to handle settings update callback:',
      callbackError,
    );
  });
});
