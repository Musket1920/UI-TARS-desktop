import { describe, expect, it, vi } from 'vitest';

import { executeChatInputRun } from './startRun';

describe('executeChatInputRun', () => {
  it('enters submitting before awaiting preflight and resets after running', async () => {
    const setRunRequestPhase = vi.fn();
    const onError = vi.fn();
    const onRun = vi.fn().mockResolvedValue(undefined);
    let resolveCheckBeforeRun: ((value: boolean) => void) | undefined;
    const checkBeforeRun = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheckBeforeRun = resolve;
        }),
    );

    const runPromise = executeChatInputRun({
      checkBeforeRun,
      setRunRequestPhase,
      onError,
      onRun,
    });

    expect(setRunRequestPhase).toHaveBeenNthCalledWith(1, 'submitting');
    expect(setRunRequestPhase.mock.invocationCallOrder[0]).toBeLessThan(
      checkBeforeRun.mock.invocationCallOrder[0],
    );
    expect(onRun).not.toHaveBeenCalled();

    resolveCheckBeforeRun?.(true);
    await runPromise;

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(setRunRequestPhase).toHaveBeenNthCalledWith(2, 'idle');
    expect(onError).not.toHaveBeenCalled();
  });

  it('shows an error and resets the request phase when run fails', async () => {
    const setRunRequestPhase = vi.fn();
    const onError = vi.fn();

    await executeChatInputRun({
      setRunRequestPhase,
      onError,
      onRun: vi.fn().mockRejectedValue(new Error('run failed hard')),
    });

    expect(setRunRequestPhase).toHaveBeenNthCalledWith(1, 'submitting');
    expect(setRunRequestPhase).toHaveBeenNthCalledWith(2, 'idle');
    expect(onError).toHaveBeenCalledWith('run failed hard');
  });

  it('resets to idle without running when preflight blocks the run', async () => {
    const setRunRequestPhase = vi.fn();
    const onError = vi.fn();
    const onRun = vi.fn();

    await executeChatInputRun({
      checkBeforeRun: vi.fn().mockResolvedValue(false),
      setRunRequestPhase,
      onError,
      onRun,
    });

    expect(onRun).not.toHaveBeenCalled();
    expect(setRunRequestPhase).toHaveBeenNthCalledWith(1, 'submitting');
    expect(setRunRequestPhase).toHaveBeenNthCalledWith(2, 'idle');
    expect(onError).not.toHaveBeenCalled();
  });

  it('shows an error and leaves the request phase idle when preflight fails', async () => {
    const setRunRequestPhase = vi.fn();
    const onError = vi.fn();
    const onRun = vi.fn();

    await executeChatInputRun({
      checkBeforeRun: vi.fn().mockRejectedValue(new Error('preflight failed')),
      setRunRequestPhase,
      onError,
      onRun,
    });

    expect(onRun).not.toHaveBeenCalled();
    expect(setRunRequestPhase).toHaveBeenNthCalledWith(1, 'submitting');
    expect(setRunRequestPhase).toHaveBeenNthCalledWith(2, 'idle');
    expect(onError).toHaveBeenCalledWith('preflight failed');
  });
});
