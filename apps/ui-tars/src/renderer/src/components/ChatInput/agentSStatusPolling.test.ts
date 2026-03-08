import { describe, expect, it, vi } from 'vitest';

import { createAgentSStatusPoller } from './agentSStatusPolling';

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
};

describe('createAgentSStatusPoller', () => {
  it('clears status without polling when Agent-S is not selected', async () => {
    const setLoadingStatus = vi.fn();
    const setStatus = vi.fn();
    const fetchStatus = vi.fn();

    const poller = createAgentSStatusPoller<string, string>({
      isSelected: () => false,
      setLoadingStatus,
      setStatus,
      fetchStatus,
    });

    await poller.poll();

    expect(fetchStatus).not.toHaveBeenCalled();
    expect(setLoadingStatus).toHaveBeenCalledTimes(1);
    expect(setLoadingStatus).toHaveBeenCalledWith(false);
    expect(setStatus).toHaveBeenCalledWith({
      health: null,
      runtimeStatus: null,
    });
  });

  it('does not publish fulfilled results after stop', async () => {
    const setLoadingStatus = vi.fn();
    const setStatus = vi.fn();
    const deferred = createDeferred<{
      health: string;
      runtimeStatus: string;
    }>();

    const poller = createAgentSStatusPoller<string, string>({
      isSelected: () => true,
      setLoadingStatus,
      setStatus,
      fetchStatus: () => deferred.promise,
    });

    const pollPromise = poller.poll();
    poller.stop();
    deferred.resolve({ health: 'healthy', runtimeStatus: 'active' });

    await pollPromise;

    expect(setLoadingStatus).toHaveBeenCalledTimes(1);
    expect(setLoadingStatus).toHaveBeenCalledWith(true);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('does not clear state after stop when polling rejects', async () => {
    const setLoadingStatus = vi.fn();
    const setStatus = vi.fn();
    const onPollError = vi.fn();
    const deferred = createDeferred<{
      health: string;
      runtimeStatus: string;
    }>();

    const poller = createAgentSStatusPoller<string, string>({
      isSelected: () => true,
      setLoadingStatus,
      setStatus,
      fetchStatus: () => deferred.promise,
      onPollError,
    });

    const pollPromise = poller.poll();
    poller.stop();
    deferred.reject(new Error('poll failed'));

    await pollPromise;

    expect(setLoadingStatus).toHaveBeenCalledTimes(1);
    expect(setLoadingStatus).toHaveBeenCalledWith(true);
    expect(onPollError).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
