/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockShortcuts = vi.hoisted(() => vi.fn());

vi.mock('@agent-infra/browser', () => ({
  BrowserFinder: class {},
  LocalBrowser: class {},
  RemoteBrowser: class {},
}));

vi.mock('@agent-infra/logger', () => ({
  ConsoleLogger: class {},
  defaultLogger: {
    spawn: () => mockLogger,
  },
}));

vi.mock('@ui-tars/sdk/core', () => ({
  Operator: class {},
  parseBoxToScreenCoords: vi.fn(),
}));

vi.mock('../src/ui-helper', () => ({
  UIHelper: class {
    public cleanup = vi.fn();
  },
}));

vi.mock('../src/shortcuts', () => ({
  shortcuts: mockShortcuts,
}));

import { BrowserOperator } from '../src/browser-operator';
import { shortcuts } from '../src/shortcuts';

function createPage() {
  return {
    keyboard: {
      down: vi.fn(),
      press: vi.fn(),
      type: vi.fn(),
      up: vi.fn(),
    },
  };
}

function createOperator(page: ReturnType<typeof createPage>) {
  return new BrowserOperator({
    browser: {
      getActivePage: vi.fn().mockResolvedValue(page),
    } as any,
    browserType: 'chrome' as any,
  });
}

describe('BrowserOperator handleType', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('releases the select-all modifier if KeyA throws while clearing exact empty-string content', async () => {
    const page = createPage();
    const operator = createOperator(page);
    const expectedModifier = os.platform() === 'darwin' ? 'Meta' : 'Control';
    const keyAError = new Error('KeyA failed');

    page.keyboard.press.mockRejectedValueOnce(keyAError);

    await expect((operator as any).handleType({ content: '' })).rejects.toThrow(
      keyAError,
    );

    expect(page.keyboard.down).toHaveBeenCalledWith(expectedModifier);
    expect(page.keyboard.press).toHaveBeenCalledTimes(1);
    expect(page.keyboard.press).toHaveBeenCalledWith('KeyA');
    expect(page.keyboard.up).toHaveBeenCalledWith(expectedModifier);
    expect(page.keyboard.up.mock.invocationCallOrder[0]).toBeGreaterThan(
      page.keyboard.press.mock.invocationCallOrder[0],
    );
    expect(page.keyboard.press).not.toHaveBeenCalledWith('Backspace');
    expect(page.keyboard.type).not.toHaveBeenCalled();
  });

  it('keeps non-empty content typing behavior unchanged', async () => {
    const page = createPage();
    const operator = createOperator(page);

    await (operator as any).handleType({ content: 'hello world' });

    expect(shortcuts).not.toHaveBeenCalled();
    expect(page.keyboard.type).toHaveBeenCalledWith('hello world', {
      delay: expect.any(Number),
    });
    expect(page.keyboard.press).not.toHaveBeenCalledWith('Backspace');
  });

  it('types whitespace-only non-empty content as provided', async () => {
    const page = createPage();
    const operator = createOperator(page);
    const content = ' \t ';

    await (operator as any).handleType({ content });

    expect(shortcuts).not.toHaveBeenCalled();
    expect(page.keyboard.type).toHaveBeenCalledWith(content, {
      delay: expect.any(Number),
    });
    expect(page.keyboard.press).not.toHaveBeenCalledWith('Backspace');
  });
});
