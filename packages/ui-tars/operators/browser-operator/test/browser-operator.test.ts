/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
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
import { KEY_MAPPINGS } from '../src/key-map';
import { shortcuts } from '../src/shortcuts';

function createPage() {
  return {
    keyboard: {
      press: vi.fn(),
      type: vi.fn(),
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

  it('selects all before clearing exact empty-string content', async () => {
    const page = createPage();
    const operator = createOperator(page);

    await (operator as any).handleType({ content: '' });

    expect(shortcuts).toHaveBeenCalledWith(
      page,
      [KEY_MAPPINGS.control, KEY_MAPPINGS.a],
      'chrome',
    );
    expect(page.keyboard.press).toHaveBeenCalledWith('Backspace');
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

  it('keeps whitespace-only content on the existing no-op path', async () => {
    const page = createPage();
    const operator = createOperator(page);

    await (operator as any).handleType({ content: '   ' });

    expect(shortcuts).not.toHaveBeenCalled();
    expect(page.keyboard.type).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });
});
