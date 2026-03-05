/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { StatusEnum } from '@ui-tars/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  pauseAgentSRuntime,
  resetAgentSLifecycle,
  setAgentSActive,
  isAgentSActive,
} from '@main/services/agentS/lifecycle';
import { store } from '@main/store/create';
import { showWindow } from '@main/window/index';
import { closeScreenMarker } from '@main/window/ScreenMarker';
import { agentRoute, GUIAgentManager } from './agent';

type PauseRunContext = Parameters<
  typeof agentRoute.pauseRun.handle
>[0]['context'];
type ResumeRunContext = Parameters<
  typeof agentRoute.resumeRun.handle
>[0]['context'];
type StopRunContext = Parameters<
  typeof agentRoute.stopRun.handle
>[0]['context'];

vi.mock('@main/services/runAgent', () => ({
  runAgent: vi.fn(),
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

vi.mock('@main/window/index', () => ({
  showWindow: vi.fn(),
}));

vi.mock('@main/window/ScreenMarker', () => ({
  closeScreenMarker: vi.fn(),
}));

vi.mock('@main/store/create', () => {
  const state = {
    thinking: false,
    abortController: null,
    status: 'init',
    agentSPaused: false,
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

describe('agent-s-lifecycle pause/resume/stop parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const baseState = store.getState();
    baseState.thinking = false;
    baseState.abortController = null;
    baseState.status = StatusEnum.INIT;
    baseState.agentSPaused = false;

    resetAgentSLifecycle();
    setAgentSActive(false);

    GUIAgentManager.getInstance().clearAgent();
  });

  afterEach(() => {
    resetAgentSLifecycle();
    setAgentSActive(false);
  });

  it('pauseRun without GUIAgent leaves thinking unchanged', async () => {
    await agentRoute.pauseRun.handle({
      input: undefined,
      context: {} as PauseRunContext,
    });

    expect(store.setState).not.toHaveBeenCalled();
    expect(store.getState().thinking).toBe(false);
  });

  it('resumeRun without GUIAgent leaves thinking unchanged', async () => {
    await agentRoute.resumeRun.handle({
      input: undefined,
      context: {} as ResumeRunContext,
    });

    expect(store.setState).not.toHaveBeenCalled();
    expect(store.getState().thinking).toBe(false);
  });

  it('pauseRun pauses Agent-S runtime and updates state when active', async () => {
    if (!isAgentSActive()) {
      setAgentSActive(true);
    }

    await agentRoute.pauseRun.handle({
      input: undefined,
      context: {} as PauseRunContext,
    });

    expect(store.setState).toHaveBeenCalled();
    expect(store.getState().agentSPaused).toBe(true);
  });

  it('resumeRun resumes Agent-S runtime and updates thinking flag when paused', async () => {
    setAgentSActive(true);
    pauseAgentSRuntime();

    await agentRoute.resumeRun.handle({
      input: undefined,
      context: {} as ResumeRunContext,
    });

    expect(store.getState().agentSPaused).toBe(false);
  });

  it('stopRun aborts controller and resets status with cleanup', async () => {
    const fakeAbortController = new AbortController();
    const abortSpy = vi.spyOn(fakeAbortController, 'abort');
    store.getState().abortController = fakeAbortController;

    await agentRoute.stopRun.handle({
      input: undefined,
      context: {} as StopRunContext,
    });

    expect(store.setState).toHaveBeenCalledTimes(1);
    expect(store.setState).toHaveBeenCalledWith({
      status: StatusEnum.END,
      thinking: false,
      agentSPaused: false,
    });
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(showWindow).toHaveBeenCalledTimes(1);
    expect(closeScreenMarker).toHaveBeenCalledTimes(1);
  });
});
