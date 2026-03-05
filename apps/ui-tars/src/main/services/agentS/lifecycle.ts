/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
const lifecycleState = {
  active: false,
  paused: false,
};

const resumeWaiters = new Set<() => void>();

const flushResumeWaiters = () => {
  const waiters = Array.from(resumeWaiters);
  resumeWaiters.clear();
  waiters.forEach((waiter) => {
    waiter();
  });
};

const waitForResume = async (signal?: AbortSignal) => {
  if (!lifecycleState.paused) {
    return;
  }

  await new Promise<void>((resolve) => {
    const listener = () => {
      resumeWaiters.delete(listener);
      resolve();
    };

    resumeWaiters.add(listener);

    signal?.addEventListener(
      'abort',
      () => {
        if (resumeWaiters.delete(listener)) {
          resolve();
        }
      },
      { once: true },
    );
  });
};

export const pauseAgentSRuntime = () => {
  if (!lifecycleState.active || lifecycleState.paused) {
    return false;
  }

  lifecycleState.paused = true;
  return true;
};

export const resumeAgentSRuntime = () => {
  if (!lifecycleState.active || !lifecycleState.paused) {
    return false;
  }

  lifecycleState.paused = false;
  flushResumeWaiters();
  return true;
};

export const resetAgentSLifecycle = () => {
  lifecycleState.paused = false;
  flushResumeWaiters();
};

export const setAgentSActive = (value: boolean) => {
  lifecycleState.active = value;
  if (!value) {
    resetAgentSLifecycle();
  }
};

export const isAgentSActive = () => lifecycleState.active;

export const isAgentSPaused = () => lifecycleState.paused;

export const ensureAgentSNotPaused = async (signal?: AbortSignal) => {
  while (lifecycleState.paused) {
    if (signal?.aborted) {
      return;
    }

    await waitForResume(signal);
  }
};
