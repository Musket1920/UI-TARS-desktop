import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clipboard, desktopCapturer, screen } from 'electron';
import { Key, keyboard } from '@computer-use/nut-js';

import { NutJSElectronOperator } from './operator';

const electronMocks = vi.hoisted(() => ({
  screen: {
    getPrimaryDisplay: vi.fn(),
  },
  desktopCapturer: {
    getSources: vi.fn(),
  },
  clipboard: {
    readText: vi.fn(),
    writeText: vi.fn(),
  },
}));

const nutJsMocks = vi.hoisted(() => ({
  keyboard: {
    pressKey: vi.fn(),
    releaseKey: vi.fn(),
  },
}));

const baseOperatorMocks = vi.hoisted(() => ({
  execute: vi.fn(),
  screenshot: vi.fn(),
}));

vi.mock('electron', () => ({
  ...electronMocks,
  app: {
    on: vi.fn(),
    off: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
    relaunch: vi.fn(),
  },
}));

vi.mock('@computer-use/nut-js', () => ({
  Key: {
    LeftControl: 'LeftControl',
    V: 'V',
  },
  keyboard: nutJsMocks.keyboard,
}));

vi.mock('@main/env', () => ({
  isMacOS: false,
  isWindows: true,
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

vi.mock('@ui-tars/shared/utils', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@ui-tars/operator-nut-js', () => ({
  NutJSOperator: class {
    async execute(...args: unknown[]) {
      return await baseOperatorMocks.execute(...args);
    }

    async screenshot(...args: unknown[]) {
      return await baseOperatorMocks.screenshot(...args);
    }
  },
}));

describe('NutJSElectronOperator', () => {
  let operator: NutJSElectronOperator;

  beforeEach(() => {
    operator = new NutJSElectronOperator();
    vi.clearAllMocks();
    vi.mocked(clipboard.readText).mockReturnValue('original clipboard');
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('screenshot', () => {
    it('should capture screenshot successfully', async () => {
      const mockDisplay = {
        id: '1',
        size: { width: 1920, height: 1080 },
        scaleFactor: 1,
      };
      const mockSource = {
        display_id: '1',
        thumbnail: {
          resize: () => ({
            toJPEG: () => Buffer.from('mock-image'),
          }),
        },
      };

      vi.mocked(screen.getPrimaryDisplay).mockReturnValue(
        mockDisplay as unknown as ReturnType<typeof screen.getPrimaryDisplay>,
      );
      vi.mocked(desktopCapturer.getSources).mockResolvedValueOnce([
        mockSource,
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      const result = await operator.screenshot();

      expect(result).toEqual({
        base64: 'bW9jay1pbWFnZQ==',
        scaleFactor: 1,
      });
      expect(desktopCapturer.getSources).toHaveBeenCalledWith({
        types: ['screen'],
        thumbnailSize: {
          width: 1920,
          height: 1080,
        },
      });
    });
  });

  describe('execute', () => {
    it('treats empty content as an intentional clear on Windows', async () => {
      await operator.execute({
        parsedPrediction: {
          action_type: 'type',
          action_inputs: { content: '' },
        },
      } as never);

      expect(clipboard.writeText).toHaveBeenNthCalledWith(1, '');
      expect(keyboard.pressKey).toHaveBeenCalledWith(Key.LeftControl, Key.V);
      expect(keyboard.releaseKey).toHaveBeenCalledWith(Key.LeftControl, Key.V);
      expect(clipboard.writeText).toHaveBeenNthCalledWith(
        2,
        'original clipboard',
      );
      expect(baseOperatorMocks.execute).not.toHaveBeenCalled();
    });

    it('keeps missing content on the superclass path', async () => {
      const baseResult = { status: 'super-result' };
      baseOperatorMocks.execute.mockResolvedValue(baseResult);

      const result = await operator.execute({
        parsedPrediction: {
          action_type: 'type',
          action_inputs: {},
        },
      } as never);

      expect(result).toBe(baseResult);
      expect(baseOperatorMocks.execute).toHaveBeenCalledTimes(1);
      expect(clipboard.writeText).not.toHaveBeenCalled();
      expect(keyboard.pressKey).not.toHaveBeenCalled();
    });
  });
});
