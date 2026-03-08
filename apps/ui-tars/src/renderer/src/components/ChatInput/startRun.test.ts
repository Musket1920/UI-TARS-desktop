import { describe, expect, it, vi } from 'vitest';

import { executeChatInputRun } from './startRun';

describe('executeChatInputRun', () => {
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
    expect(setRunRequestPhase).toHaveBeenCalledTimes(1);
    expect(setRunRequestPhase).toHaveBeenCalledWith('idle');
    expect(onError).toHaveBeenCalledWith('preflight failed');
  });
});
