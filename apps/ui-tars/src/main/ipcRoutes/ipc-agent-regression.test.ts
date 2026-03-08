/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { StatusEnum } from '@ui-tars/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isAgentSActive,
  pauseAgentSRuntime,
  resetAgentSLifecycle,
  setAgentSActive,
} from '@main/services/agentS/lifecycle';
import { store } from '@main/store/create';
import { closeScreenMarker } from '@main/window/ScreenMarker';
import { showWindow } from '@main/window/index';
import { agentRoute, GUIAgentManager } from './agent';

type RunAgentContext = Parameters<
  typeof agentRoute.runAgent.handle
>[0]['context'];
type PauseRunContext = Parameters<
  typeof agentRoute.pauseRun.handle
>[0]['context'];
type RuntimeStatusContext = Parameters<
  typeof agentRoute.getAgentRuntimeStatus.handle
>[0]['context'];
type ResumeRunContext = Parameters<
  typeof agentRoute.resumeRun.handle
>[0]['context'];
type StopRunContext = Parameters<
  typeof agentRoute.stopRun.handle
>[0]['context'];

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('@main/services/runAgent', () => ({
  runAgent: runAgentMock,
}));

vi.mock('@main/services/agentS/telemetry', () => ({
  sanitizeAgentSBoundaryPayload: <T>(value: T) => value,
}));

vi.mock('@main/window/index', () => ({
  showWindow: vi.fn(),
}));

vi.mock('@main/window/ScreenMarker', () => ({
  closeScreenMarker: vi.fn(),
}));

vi.mock('@main/store/setting', () => ({
  SettingStore: {
    getStore: vi.fn(() => ({
      engineMode: 'agent-s',
    })),
  },
}));

vi.mock('@main/services/agentS/sidecarManager', () => ({
  classifyAgentSFailureReason: (reasonCode: string | null | undefined) =>
    reasonCode ? 'unavailable' : 'degraded_fallback',
  agentSSidecarManager: {
    health: vi.fn(),
    getStatus: vi.fn(() => ({
      state: 'stopped',
      mode: null,
      healthy: false,
      endpoint: null,
      pid: null,
      checkedAt: 1,
      lastHeartbeatAt: null,
      reason: 'stop_requested',
    })),
    getCircuitBreakerStatus: vi.fn(() => ({
      state: 'closed',
      open: false,
      canProbe: false,
      nextProbeAt: null,
      failureThreshold: 3,
      cooldownMs: 20_000,
      consecutiveFailures: 0,
      openedAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      lastFailureClass: null,
      lastRecoveryAt: null,
    })),
  },
}));

vi.mock('@main/store/create', () => {
  const state = {
    thinking: false,
    abortController: null,
    status: 'init',
    agentSPaused: false,
    errorMsg: null,
    instructions: '',
    messages: [],
    sessionHistoryMessages: [],
  };

  return {
    store: {
      setState: vi.fn((patch) => {
        Object.assign(state, patch);
      }),
      getState: vi.fn(() => state),
    },
  };
});

describe('ipc-agent-regression existing agent routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runAgentMock.mockResolvedValue(undefined);

    const baseState = store.getState();
    baseState.thinking = false;
    baseState.abortController = null;
    baseState.status = StatusEnum.INIT;
    baseState.agentSPaused = false;
    baseState.errorMsg = null;
    baseState.instructions = '';
    baseState.messages = [];
    baseState.sessionHistoryMessages = [];

    resetAgentSLifecycle();
    setAgentSActive(false);

    GUIAgentManager.getInstance().clearAgent();
  });

  afterEach(() => {
    resetAgentSLifecycle();
    setAgentSActive(false);
  });

  it('runAgent keeps existing dispatch behavior', async () => {
    await agentRoute.runAgent.handle({
      input: undefined,
      context: {} as RunAgentContext,
    });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(store.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: true,
        errorMsg: null,
        agentSPaused: false,
      }),
    );
    expect(store.setState).toHaveBeenCalledWith({ thinking: false });
  });

  it('runAgent clears thinking when runAgent throws', async () => {
    const failure = new Error('greptile failure');
    runAgentMock.mockRejectedValueOnce(failure);

    await expect(
      agentRoute.runAgent.handle({
        input: undefined,
        context: {} as RunAgentContext,
      }),
    ).rejects.toThrow(failure);

    expect(store.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: true,
        errorMsg: null,
        agentSPaused: false,
      }),
    );
    expect(store.setState).toHaveBeenCalledWith({ thinking: false });
    expect(store.getState().thinking).toBe(false);
  });

  it('runAgent still no-ops when already thinking', async () => {
    store.getState().thinking = true;

    await agentRoute.runAgent.handle({
      input: undefined,
      context: {} as RunAgentContext,
    });

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(store.setState).not.toHaveBeenCalled();
  });

  it('pause/resume/stop lifecycle behavior remains unchanged', async () => {
    if (!isAgentSActive()) {
      setAgentSActive(true);
    }

    await agentRoute.pauseRun.handle({
      input: undefined,
      context: {} as PauseRunContext,
    });
    expect(store.getState().agentSPaused).toBe(true);

    pauseAgentSRuntime();
    await agentRoute.resumeRun.handle({
      input: undefined,
      context: {} as ResumeRunContext,
    });
    expect(store.getState().agentSPaused).toBe(false);

    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, 'abort');
    store.getState().abortController = abortController;

    await agentRoute.stopRun.handle({
      input: undefined,
      context: {} as StopRunContext,
    });

    expect(store.setState).toHaveBeenCalledWith({
      status: StatusEnum.END,
      thinking: false,
      agentSPaused: false,
    });
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(showWindow).toHaveBeenCalledTimes(1);
    expect(closeScreenMarker).toHaveBeenCalledTimes(1);
  });

  it('resume restores thinking for a paused active Agent-S run', async () => {
    store.getState().thinking = true;
    setAgentSActive(true);

    await agentRoute.pauseRun.handle({
      input: undefined,
      context: {} as PauseRunContext,
    });

    expect(store.getState().agentSPaused).toBe(true);
    expect(store.getState().thinking).toBe(false);

    await agentRoute.resumeRun.handle({
      input: undefined,
      context: {} as ResumeRunContext,
    });

    expect(store.getState().agentSPaused).toBe(false);
    expect(store.getState().thinking).toBe(true);

    const runtimeStatus = await agentRoute.getAgentRuntimeStatus.handle({
      input: undefined,
      context: {} as RuntimeStatusContext,
    });

    expect(runtimeStatus).toMatchObject({
      status: 'running',
      engine: {
        active: true,
        paused: false,
        thinking: true,
      },
      controls: {
        canRun: false,
        canPause: true,
        canResume: false,
        canStop: true,
      },
    });
  });
});
