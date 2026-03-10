/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  },
}));

import { logger } from '@main/logger';
import { translateAgentSAction } from './actionTranslator';

describe('action-translator', () => {
  it('maps click synonyms to left_click with normalized start_box', () => {
    const result = translateAgentSAction("left_single(point='(100,200)')");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalizedAction).toBe('left_click');
      expect(result.parsed).toEqual({
        action_type: 'left_click',
        action_inputs: { start_box: '[100,200,100,200]' },
        thought: '',
        reflection: null,
      });
    }
  });

  it('maps double/right click actions', () => {
    const doubleClick = translateAgentSAction({
      action: 'double_click',
      action_inputs: { start_box: [10, 20, 30, 40] },
    });
    const rightClick = translateAgentSAction({
      action: 'right_click',
      action_inputs: { point: [15, 25] },
    });

    expect(doubleClick.ok).toBe(true);
    expect(rightClick.ok).toBe(true);

    if (doubleClick.ok) {
      expect(doubleClick.parsed.action_type).toBe('double_click');
    }

    if (rightClick.ok) {
      expect(rightClick.parsed.action_type).toBe('right_click');
      expect(rightClick.parsed.action_inputs.start_box).toBe('[15,25,15,25]');
    }
  });

  it('maps drag/type/hotkey/scroll/wait/done/fail deterministically', () => {
    const drag = translateAgentSAction(
      "drag(start_point='(1,2)', end_point='(3,4)')",
    );
    const typing = translateAgentSAction({
      action: 'type',
      action_inputs: { content: 'hello world' },
    });
    const hotkey = translateAgentSAction({
      action: 'hotkey',
      action_inputs: { keys: ['ctrl', 'c'] },
    });
    const scroll = translateAgentSAction({
      action: 'scroll',
      action_inputs: { direction: 'downward' },
    });
    const wait = translateAgentSAction('wait()');
    const done = translateAgentSAction('done()');
    const fail = translateAgentSAction('fail()');

    expect(drag.ok).toBe(true);
    expect(typing.ok).toBe(true);
    expect(hotkey.ok).toBe(true);
    expect(scroll.ok).toBe(true);
    expect(wait.ok).toBe(true);
    expect(done.ok).toBe(true);
    expect(fail.ok).toBe(true);

    if (drag.ok) {
      expect(drag.parsed.action_inputs).toEqual({
        start_box: '[1,2,1,2]',
        end_box: '[3,4,3,4]',
      });
    }

    if (typing.ok) {
      expect(typing.parsed.action_inputs).toEqual({ content: 'hello world' });
    }

    if (hotkey.ok) {
      expect(hotkey.parsed.action_inputs).toEqual({ key: 'ctrl+c' });
    }

    if (scroll.ok) {
      expect(scroll.parsed.action_inputs).toEqual({ direction: 'down' });
    }

    if (done.ok) {
      expect(done.parsed.action_type).toBe('finished');
    }

    if (fail.ok) {
      expect(fail.parsed.action_type).toBe('call_user');
    }
  });

  it('accepts semicolons and code-like text inside type content', () => {
    const result = translateAgentSAction(
      "type(content='import pyautogui; pyautogui.click(1,2)')",
    );

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.normalizedAction).toBe('type');
      expect(result.parsed.action_inputs).toEqual({
        content: 'import pyautogui; pyautogui.click(1,2)',
      });
    }
  });

  it('accepts commas inside double-quoted type text but still rejects top-level multi-statements', () => {
    const valid = translateAgentSAction('type(text="hello, world")');
    const invalid = translateAgentSAction('type(text="hello, world"); wait()');

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);

    if (valid.ok) {
      expect(valid.normalizedAction).toBe('type');
      expect(valid.parsed.action_inputs).toEqual({ content: 'hello, world' });
    }

    if (!invalid.ok) {
      expect(invalid.code).toBe('TRANSLATION_MALFORMED_INPUT');
      expect(invalid.message).toBe('Only single action calls are supported');
    }
  });

  it('accepts literal newlines inside quoted type text', () => {
    const result = translateAgentSAction('type(text="hello\nworld")');

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.normalizedAction).toBe('type');
      expect(result.parsed.action_inputs).toEqual({
        content: 'hello\nworld',
      });
    }
  });

  it('accepts escaped quotes inside quoted type text', () => {
    const escapedSingleQuote = translateAgentSAction(
      "type(text='it\\'s done')",
    );
    const escapedDoubleQuote = translateAgentSAction(
      'type(text="say \\\"hi\\\", then stop")',
    );

    expect(escapedSingleQuote.ok).toBe(true);
    expect(escapedDoubleQuote.ok).toBe(true);

    if (escapedSingleQuote.ok) {
      expect(escapedSingleQuote.normalizedAction).toBe('type');
      expect(escapedSingleQuote.parsed.action_inputs).toEqual({
        content: "it's done",
      });
    }

    if (escapedDoubleQuote.ok) {
      expect(escapedDoubleQuote.normalizedAction).toBe('type');
      expect(escapedDoubleQuote.parsed.action_inputs).toEqual({
        content: 'say "hi", then stop',
      });
    }
  });

  it('accepts intentionally empty type content when the field is present', () => {
    const result = translateAgentSAction("type(text='')");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalizedAction).toBe('type');
      expect(result.parsed).toEqual({
        action_type: 'type',
        action_inputs: { content: '' },
        thought: '',
        reflection: null,
      });
    }
  });

  it('still returns missing-required-field when type content is absent', () => {
    const result = translateAgentSAction({
      action: 'type',
      action_inputs: { payload: 'hello', delay_ms: 25 },
    });

    expect(result).toEqual({
      ok: false,
      code: 'TRANSLATION_MISSING_REQUIRED_FIELD',
      message:
        'Missing required field: content (available keys: delay_ms, payload)',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[agentS actionTranslator] Type action missing content/text/value; available keys: delay_ms, payload',
    );
  });

  it('preserves optional scroll coordinates in start_box', () => {
    const result = translateAgentSAction({
      action: 'scroll',
      action_inputs: {
        direction: 'up',
        point: [45, 90],
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalizedAction).toBe('scroll');
      expect(result.parsed).toEqual({
        action_type: 'scroll',
        action_inputs: {
          direction: 'up',
          start_box: '[45,90,45,90]',
        },
        thought: '',
        reflection: null,
      });
    }
  });

  it('maps scroll coordinate and position aliases into start_box', () => {
    const coordinate = translateAgentSAction({
      action: 'scroll',
      action_inputs: {
        direction: 'down',
        coordinate: [12, 34],
      },
    });
    const position = translateAgentSAction({
      action: 'scroll',
      action_inputs: {
        direction: 'up',
        position: [56, 78],
      },
    });

    expect(coordinate.ok).toBe(true);
    expect(position.ok).toBe(true);

    if (coordinate.ok) {
      expect(coordinate.normalizedAction).toBe('scroll');
      expect(coordinate.parsed.action_inputs).toEqual({
        direction: 'down',
        start_box: '[12,34,12,34]',
      });
    }

    if (position.ok) {
      expect(position.normalizedAction).toBe('scroll');
      expect(position.parsed.action_inputs).toEqual({
        direction: 'up',
        start_box: '[56,78,56,78]',
      });
    }
  });

  it('returns TRANSLATION_UNSUPPORTED_ACTION for unknown action', () => {
    const result = translateAgentSAction({
      action: 'open_app',
      action_inputs: { app: 'Calculator' },
    });

    expect(result).toEqual({
      ok: false,
      code: 'TRANSLATION_UNSUPPORTED_ACTION',
      message: 'Unsupported Agent-S action: open_app',
    });
  });

  it('returns typed errors for malformed/ambiguous/missing required fields', () => {
    const malformed = translateAgentSAction("click(start_box='abc')");
    const ambiguous = translateAgentSAction({
      action: 'click',
      action_inputs: {
        start_box: [1, 2, 3, 4],
        point: [9, 9],
      },
    });
    const missingRequired = translateAgentSAction({
      action: 'hotkey',
      action_inputs: {},
    });
    const blockedCode = translateAgentSAction(
      'import pyautogui; pyautogui.click(1,2)',
    );

    expect(malformed.ok).toBe(false);
    expect(ambiguous.ok).toBe(false);
    expect(missingRequired.ok).toBe(false);
    expect(blockedCode.ok).toBe(false);

    if (!malformed.ok) {
      expect(malformed.code).toBe('TRANSLATION_MALFORMED_INPUT');
    }

    if (!ambiguous.ok) {
      expect(ambiguous.code).toBe('TRANSLATION_AMBIGUOUS_INPUT');
    }

    if (!missingRequired.ok) {
      expect(missingRequired.code).toBe('TRANSLATION_MISSING_REQUIRED_FIELD');
    }

    if (!blockedCode.ok) {
      expect(blockedCode.code).toBe('TRANSLATION_MALFORMED_INPUT');
    }
  });
});
