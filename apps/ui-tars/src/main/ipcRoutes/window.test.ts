import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@main/window/createWindow', () => ({
  appUpdater: null,
}));

vi.mock('@main/window/index', () => ({
  showWindow: vi.fn(),
}));

import { windowRoute } from './window';
import { showWindow } from '@main/window/index';

type ShowMainWindowContext = Parameters<
  typeof windowRoute.showMainWindow.handle
>[0]['context'];

const showWindowMock = vi.mocked(showWindow);

vi.mock('@main/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  },
}));

describe('windowRoute.showMainWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call showWindow function', async () => {
    await windowRoute.showMainWindow.handle({
      input: undefined,
      context: {} as ShowMainWindowContext,
    });

    expect(showWindow).toHaveBeenCalled();
    expect(showWindow).toHaveBeenCalledTimes(1);
  });

  it('should handle showWindow being called multiple times', async () => {
    await windowRoute.showMainWindow.handle({
      input: undefined,
      context: {} as ShowMainWindowContext,
    });
    await windowRoute.showMainWindow.handle({
      input: undefined,
      context: {} as ShowMainWindowContext,
    });
    await windowRoute.showMainWindow.handle({
      input: undefined,
      context: {} as ShowMainWindowContext,
    });

    expect(showWindow).toHaveBeenCalledTimes(3);
  });

  it('should handle errors from showWindow', async () => {
    showWindowMock.mockImplementationOnce(() => {
      throw new Error('Failed to show window');
    });

    await expect(
      windowRoute.showMainWindow.handle({
        input: undefined,
        context: {} as ShowMainWindowContext,
      }),
    ).rejects.toThrow('Failed to show window');
  });
});
