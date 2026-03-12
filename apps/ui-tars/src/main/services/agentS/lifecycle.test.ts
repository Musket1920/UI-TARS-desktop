/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureAgentSNotPaused,
  isAgentSPaused,
  pauseAgentSRuntime,
  resetAgentSLifecycle,
  resumeAgentSRuntime,
  setAgentSActive,
} from './lifecycle';

describe('Agent-S lifecycle pause guard', () => {
  afterEach(() => {
    resetAgentSLifecycle();
    setAgentSActive(false);
  });

  it('resolves after resume when paused', async () => {
    setAgentSActive(true);
    expect(pauseAgentSRuntime()).toBe(true);
    expect(isAgentSPaused()).toBe(true);

    const waitPromise = ensureAgentSNotPaused();
    let resumed = false;
    waitPromise.then(() => {
      resumed = true;
    });

    await Promise.resolve();
    expect(resumed).toBe(false);

    expect(resumeAgentSRuntime()).toBe(true);
    await waitPromise;

    expect(resumed).toBe(true);
    expect(isAgentSPaused()).toBe(false);
  });

  it('resolves promptly when abort fires during waiter registration', async () => {
    setAgentSActive(true);
    expect(pauseAgentSRuntime()).toBe(true);

    const controller = new AbortController();
    const originalAddEventListener = controller.signal.addEventListener.bind(
      controller.signal,
    );

    vi.spyOn(controller.signal, 'addEventListener').mockImplementation(
      (type, listener, options) => {
        if (type === 'abort' && !controller.signal.aborted) {
          controller.abort();
        }

        return originalAddEventListener(type, listener, options);
      },
    );

    const waitPromise = ensureAgentSNotPaused(controller.signal);
    const outcome = await Promise.race([
      waitPromise.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          resolve('timeout');
        }, 50);
      }),
    ]);

    expect(outcome).toBe('resolved');
    expect(controller.signal.aborted).toBe(true);
    expect(isAgentSPaused()).toBe(true);
  });
});
