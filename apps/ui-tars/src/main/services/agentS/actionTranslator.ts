/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  type ActionInputs,
  type PredictionParsed,
} from '@ui-tars/shared/types';

export type AgentSActionLikeInput = string | Record<string, unknown>;

export type TranslationErrorCode =
  | 'TRANSLATION_UNSUPPORTED_ACTION'
  | 'TRANSLATION_AMBIGUOUS_INPUT'
  | 'TRANSLATION_MISSING_REQUIRED_FIELD'
  | 'TRANSLATION_MALFORMED_INPUT';

type NormalizedAction =
  | 'left_click'
  | 'double_click'
  | 'right_click'
  | 'drag'
  | 'type'
  | 'hotkey'
  | 'scroll'
  | 'wait'
  | 'finished'
  | 'call_user';

export type AgentSActionTranslationError = {
  ok: false;
  code: TranslationErrorCode;
  message: string;
};

export type AgentSActionTranslationSuccess = {
  ok: true;
  normalizedAction: NormalizedAction;
  parsed: PredictionParsed;
};

export type AgentSActionTranslationResult =
  | AgentSActionTranslationError
  | AgentSActionTranslationSuccess;

const ACTION_ALIASES: Record<string, NormalizedAction> = {
  click: 'left_click',
  left_click: 'left_click',
  left_single: 'left_click',
  double_click: 'double_click',
  left_double: 'double_click',
  right_click: 'right_click',
  right_single: 'right_click',
  drag: 'drag',
  left_click_drag: 'drag',
  select: 'drag',
  type: 'type',
  input: 'type',
  write: 'type',
  hotkey: 'hotkey',
  shortcut: 'hotkey',
  scroll: 'scroll',
  wait: 'wait',
  sleep: 'wait',
  done: 'finished',
  finished: 'finished',
  finish: 'finished',
  fail: 'call_user',
  failure: 'call_user',
  call_user: 'call_user',
};

const DIRECTION_ALIASES: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  upward: 'up',
  downward: 'down',
};

const errorResult = (
  code: TranslationErrorCode,
  message: string,
): AgentSActionTranslationError => ({
  ok: false,
  code,
  message,
});

const isTranslationError = (
  value: unknown,
): value is AgentSActionTranslationError => {
  return (
    isRecord(value) &&
    value.ok === false &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const hasUnsafeTopLevelCode = (value: string): boolean => {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let depth = 0;
  let topLevelText = '';

  for (const char of value) {
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === '(') {
      depth += 1;
      continue;
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0) {
      topLevelText += char;
    }
  }

  return (
    topLevelText.includes(';') ||
    /\bimport\b/i.test(topLevelText) ||
    /\bpyautogui\b/i.test(topLevelText)
  );
};

const parseArgs = (
  rawArgs: string,
): Record<string, unknown> | AgentSActionTranslationError => {
  const args: Record<string, unknown> = {};

  if (rawArgs.trim() === '') {
    return args;
  }

  const pairs = rawArgs.match(/([^,'"]|"[^"]*"|'[^']*')+/g) ?? [];

  for (const pair of pairs) {
    const equalIndex = pair.indexOf('=');
    if (equalIndex <= 0) {
      return errorResult(
        'TRANSLATION_MALFORMED_INPUT',
        `Malformed action argument: ${pair}`,
      );
    }

    const key = pair.slice(0, equalIndex).trim();
    let value = pair.slice(equalIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    args[key] = value;
  }

  return args;
};

type ParsedInput = {
  action: string;
  inputs: Record<string, unknown>;
  thought: string;
  reflection: string | null;
};

const parseInput = (
  input: AgentSActionLikeInput,
): ParsedInput | AgentSActionTranslationError => {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed === '') {
      return errorResult(
        'TRANSLATION_MALFORMED_INPUT',
        'Action string is empty',
      );
    }

    const segment =
      trimmed
        .split(/Action[:：]/)
        .pop()
        ?.trim() ?? trimmed;

    if (hasUnsafeTopLevelCode(segment)) {
      return errorResult(
        'TRANSLATION_MALFORMED_INPUT',
        'Only single action calls are supported',
      );
    }

    const match = segment.match(/^(\w+)(?:\((.*)\))?$/);

    if (!match) {
      return errorResult(
        'TRANSLATION_MALFORMED_INPUT',
        'Unable to parse action call format',
      );
    }

    const [, actionName, rawArgs = ''] = match;
    const parsedArgs = parseArgs(rawArgs);
    if (isTranslationError(parsedArgs)) {
      return parsedArgs;
    }

    return {
      action: actionName,
      inputs: parsedArgs,
      thought: '',
      reflection: null,
    };
  }

  if (!isRecord(input)) {
    return errorResult(
      'TRANSLATION_MALFORMED_INPUT',
      'Agent-S input must be a string or object',
    );
  }

  const actionName =
    asNonEmptyString(input.action) ??
    asNonEmptyString(input.action_type) ??
    asNonEmptyString(input.type) ??
    asNonEmptyString(input.name);

  if (!actionName) {
    return errorResult(
      'TRANSLATION_MALFORMED_INPUT',
      'Missing required action/action_type field',
    );
  }

  let inputs: Record<string, unknown> = {};
  if (isRecord(input.action_inputs)) {
    inputs = input.action_inputs;
  } else if (isRecord(input.args)) {
    inputs = input.args;
  } else if (isRecord(input.arguments)) {
    inputs = input.arguments;
  } else if (isRecord(input.params)) {
    inputs = input.params;
  }

  return {
    action: actionName,
    inputs,
    thought: asNonEmptyString(input.thought) ?? '',
    reflection: asNonEmptyString(input.reflection),
  };
};

const toBoxString = (raw: unknown): string | null => {
  if (Array.isArray(raw)) {
    if (raw.length !== 2 && raw.length !== 4) {
      return null;
    }
    const numbers = raw.map((value) => Number(value));
    if (numbers.some((value) => Number.isNaN(value))) {
      return null;
    }
    const box =
      numbers.length === 2
        ? [numbers[0], numbers[1], numbers[0], numbers[1]]
        : numbers;
    return JSON.stringify(box);
  }

  if (isRecord(raw)) {
    if (typeof raw.x === 'number' && typeof raw.y === 'number') {
      return JSON.stringify([raw.x, raw.y, raw.x, raw.y]);
    }

    if (
      typeof raw.x1 === 'number' &&
      typeof raw.y1 === 'number' &&
      typeof raw.x2 === 'number' &&
      typeof raw.y2 === 'number'
    ) {
      return JSON.stringify([raw.x1, raw.y1, raw.x2, raw.y2]);
    }
  }

  if (typeof raw === 'string') {
    const values = (raw.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (values.length !== 2 && values.length !== 4) {
      return null;
    }
    const box =
      values.length === 2
        ? [values[0], values[1], values[0], values[1]]
        : values;
    return JSON.stringify(box);
  }

  return null;
};

const resolveSingleBox = (
  inputs: Record<string, unknown>,
  keys: string[],
  fieldName: string,
): { value: string } | AgentSActionTranslationError => {
  const candidates: string[] = [];

  for (const key of keys) {
    if (!(key in inputs)) {
      continue;
    }

    const box = toBoxString(inputs[key]);
    if (!box) {
      return errorResult(
        'TRANSLATION_MALFORMED_INPUT',
        `Invalid ${fieldName} from key '${key}'`,
      );
    }

    candidates.push(box);
  }

  if (candidates.length === 0) {
    return errorResult(
      'TRANSLATION_MISSING_REQUIRED_FIELD',
      `Missing required field: ${fieldName}`,
    );
  }

  if (new Set(candidates).size > 1) {
    return errorResult(
      'TRANSLATION_AMBIGUOUS_INPUT',
      `${fieldName} is ambiguous`,
    );
  }

  return { value: candidates[0] };
};

const parsedResult = (params: {
  actionType: string;
  actionInputs: ActionInputs;
  thought: string;
  reflection: string | null;
}): PredictionParsed => {
  return {
    action_type: params.actionType,
    action_inputs: params.actionInputs,
    thought: params.thought,
    reflection: params.reflection,
  };
};

export const translateAgentSAction = (
  input: AgentSActionLikeInput,
): AgentSActionTranslationResult => {
  const parsed = parseInput(input);
  if (isTranslationError(parsed)) {
    return parsed;
  }

  const normalizedAction = ACTION_ALIASES[parsed.action.toLowerCase()];
  if (!normalizedAction) {
    return errorResult(
      'TRANSLATION_UNSUPPORTED_ACTION',
      `Unsupported Agent-S action: ${parsed.action}`,
    );
  }

  const { inputs, thought, reflection } = parsed;

  if (
    normalizedAction === 'left_click' ||
    normalizedAction === 'double_click' ||
    normalizedAction === 'right_click'
  ) {
    const start = resolveSingleBox(
      inputs,
      ['start_box', 'point', 'start_point', 'bbox', 'box'],
      'start_box',
    );
    if (isTranslationError(start)) {
      return start;
    }

    return {
      ok: true,
      normalizedAction,
      parsed: parsedResult({
        actionType: normalizedAction,
        actionInputs: { start_box: start.value },
        thought,
        reflection,
      }),
    };
  }

  if (normalizedAction === 'drag') {
    const start = resolveSingleBox(
      inputs,
      ['start_box', 'start_point', 'point'],
      'start_box',
    );
    if (isTranslationError(start)) {
      return start;
    }

    const end = resolveSingleBox(inputs, ['end_box', 'end_point'], 'end_box');
    if (isTranslationError(end)) {
      return end;
    }

    return {
      ok: true,
      normalizedAction,
      parsed: parsedResult({
        actionType: 'drag',
        actionInputs: { start_box: start.value, end_box: end.value },
        thought,
        reflection,
      }),
    };
  }

  if (normalizedAction === 'type') {
    const content =
      asNonEmptyString(inputs.content) ??
      asNonEmptyString(inputs.text) ??
      asNonEmptyString(inputs.value);

    if (!content) {
      return errorResult(
        'TRANSLATION_MISSING_REQUIRED_FIELD',
        'Missing required field: content',
      );
    }

    return {
      ok: true,
      normalizedAction,
      parsed: parsedResult({
        actionType: 'type',
        actionInputs: { content },
        thought,
        reflection,
      }),
    };
  }

  if (normalizedAction === 'hotkey') {
    const key =
      asNonEmptyString(inputs.key) ??
      asNonEmptyString(inputs.hotkey) ??
      (Array.isArray(inputs.keys)
        ? inputs.keys
            .map((item) => asNonEmptyString(item))
            .filter((item): item is string => Boolean(item))
            .join('+')
        : null);

    if (!key) {
      return errorResult(
        'TRANSLATION_MISSING_REQUIRED_FIELD',
        'Missing required field: key',
      );
    }

    return {
      ok: true,
      normalizedAction,
      parsed: parsedResult({
        actionType: 'hotkey',
        actionInputs: { key },
        thought,
        reflection,
      }),
    };
  }

  if (normalizedAction === 'scroll') {
    const rawDirection =
      asNonEmptyString(inputs.direction) ??
      asNonEmptyString(inputs.scroll_direction);

    if (!rawDirection) {
      return errorResult(
        'TRANSLATION_MISSING_REQUIRED_FIELD',
        'Missing required field: direction',
      );
    }

    const direction = DIRECTION_ALIASES[rawDirection.toLowerCase()];
    if (!direction) {
      return errorResult(
        'TRANSLATION_MALFORMED_INPUT',
        `Unsupported scroll direction: ${rawDirection}`,
      );
    }

    return {
      ok: true,
      normalizedAction,
      parsed: parsedResult({
        actionType: 'scroll',
        actionInputs: { direction },
        thought,
        reflection,
      }),
    };
  }

  if (normalizedAction === 'wait') {
    return {
      ok: true,
      normalizedAction,
      parsed: parsedResult({
        actionType: 'wait',
        actionInputs: {},
        thought,
        reflection,
      }),
    };
  }

  return {
    ok: true,
    normalizedAction,
    parsed: parsedResult({
      actionType: normalizedAction,
      actionInputs: {},
      thought,
      reflection,
    }),
  };
};
