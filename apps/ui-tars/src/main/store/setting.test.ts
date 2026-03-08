/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_S_SAFE_DEFAULT_LOOP_INTERVAL_MS,
  AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS,
  AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
} from './safetyPolicy';
import { AgentSSidecarMode, EngineMode, LocalStore, Operator } from './types';

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
  vlmBaseUrl: 'https://vlm.example.com',
  vlmApiKey: 'key',
  vlmModelName: 'model',
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
});
