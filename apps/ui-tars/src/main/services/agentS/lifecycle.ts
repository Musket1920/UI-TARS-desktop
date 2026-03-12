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
  if (!lifecycleState.paused || signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    const cleanup = () => {
      resumeWaiters.delete(listener);
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    const listener = () => {
      finish();
    };

    const onAbort = () => {
      finish();
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    if (!lifecycleState.paused || signal?.aborted) {
      finish();
      return;
    }

    resumeWaiters.add(listener);

    if (!lifecycleState.paused || signal?.aborted) {
      finish();
    }
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
