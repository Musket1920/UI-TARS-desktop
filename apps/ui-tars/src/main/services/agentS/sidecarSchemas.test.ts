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

  it('rejects status-only running payloads as explicitly healthy', () => {
    expect(isExplicitHealthyHealthPayload({ status: 'running' })).toBe(false);
    expect(
      isExplicitHealthyHealthPayload({ healthy: true, status: 'running' }),
    ).toBe(true);
    expect(isExplicitHealthyHealthPayload({ status: 'healthy' })).toBe(true);
  });
});
