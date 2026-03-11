/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import {
  isExplicitHealthyHealthPayload,
  parseSidecarPredictionPayload,
} from './sidecarSchemas';

describe('sidecarSchemas', () => {
  it.each([
    {
      winner: 'actions[0]',
      payload: {
        actions: ['wait()'],
        action: 'done()',
        nextAction: 'fail()',
        next_action: 'scroll(direction="down")',
        code: 'type(text="later")',
        prediction: 'call_user()',
      },
      expectedAction: 'wait()',
    },
    {
      winner: 'action',
      payload: {
        action: 'wait()',
        nextAction: 'done()',
        next_action: 'fail()',
        code: 'type(text="later")',
        prediction: 'call_user()',
      },
      expectedAction: 'wait()',
    },
    {
      winner: 'nextAction',
      payload: {
        nextAction: 'wait()',
        next_action: 'done()',
        code: 'type(text="later")',
        prediction: 'call_user()',
      },
      expectedAction: 'wait()',
    },
    {
      winner: 'next_action',
      payload: {
        next_action: 'wait()',
        code: 'done()',
        prediction: 'call_user()',
      },
      expectedAction: 'wait()',
    },
    {
      winner: 'code',
      payload: {
        code: 'wait()',
        prediction: 'done()',
      },
      expectedAction: 'wait()',
    },
  ])(
    'prefers $winner when multiple action sources are present',
    ({ payload, expectedAction }) => {
      const result = parseSidecarPredictionPayload(payload);

      expect(result).not.toBeNull();
      expect(result?.action).toBe(expectedAction);
    },
  );

  it('parses direct string payloads without envelope extraction', () => {
    const result = parseSidecarPredictionPayload(
      'left_click(point=[500, 400])',
    );

    expect(result).toEqual({
      action: 'left_click(point=[500, 400])',
      predictionText: 'left_click(point=[500, 400])',
    });
  });

  it('extracts a single-source object envelope action as a string', () => {
    const result = parseSidecarPredictionPayload({
      action: 'left_click(point=[500, 400])',
    });

    expect(result).toEqual({
      action: 'left_click(point=[500, 400])',
      predictionText: 'left_click(point=[500, 400])',
    });
  });

  it.each([
    {
      label: 'thought',
      payload: {
        action: 'left_click(point=[500, 400])',
        thought: 'click the button',
      },
    },
    {
      label: 'reflection',
      payload: {
        action: 'left_click(point=[500, 400])',
        reflection: 'the prior attempt missed the target',
      },
    },
  ])(
    'treats string action payloads with $label metadata as envelopes',
    ({ payload }) => {
      const result = parseSidecarPredictionPayload(payload);

      expect(result).toEqual({
        action: 'left_click(point=[500, 400])',
        predictionText: 'left_click(point=[500, 400])',
      });
    },
  );

  it('keeps direct action objects on the direct-action path', () => {
    const result = parseSidecarPredictionPayload({
      action_type: 'left_click',
      action_inputs: { point: [500, 400] },
      thought: 'click the button',
    });

    expect(result).toEqual({
      action: {
        action_type: 'left_click',
        action_inputs: { point: [500, 400] },
        thought: 'click the button',
      },
      predictionText: JSON.stringify({
        action_type: 'left_click',
        action_inputs: { point: [500, 400] },
        thought: 'click the button',
      }),
    });
  });

  it('rejects running payloads and accepts explicit healthy statuses', () => {
    expect(isExplicitHealthyHealthPayload({ status: 'running' })).toBe(false);
    expect(
      isExplicitHealthyHealthPayload({ healthy: true, status: 'running' }),
    ).toBe(false);

    expect(isExplicitHealthyHealthPayload({ healthy: true })).toBe(true);
    expect(isExplicitHealthyHealthPayload({ status: 'ok' })).toBe(true);
    expect(isExplicitHealthyHealthPayload({ status: 'healthy' })).toBe(true);
    expect(isExplicitHealthyHealthPayload({ status: 'up' })).toBe(true);
  });
});
