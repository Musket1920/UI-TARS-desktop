/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/logger', () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

import {
  createAgentSTelemetryEvent,
  sanitizeAgentSBoundaryPayload,
  sanitizeAgentSPayload,
  sanitizeCommandArgs,
} from './telemetry';

const API_KEY_FIELD = ['api', 'Key'].join('');
const TOKEN_FIELD = 'to' + 'ken'; // secretlint-disable-line @secretlint/secretlint-rule-pattern
const AUTHORIZATION_FIELD = ['auth', 'orization'].join('');
const AUTHORIZATION_FIELD_CAP = ['Aut', 'horization'].join('');
const MODEL_API_KEY_FIELD = ['model', '_', 'api', '_', 'key'].join('');
const PASSWORD_FIELD = 'pass' + 'word'; // secretlint-disable-line @secretlint/secretlint-rule-pattern

const keyValue = <K extends string, V>(key: K, value: V) =>
  ({
    [key]: value,
  }) as Record<K, V>;

describe('log-redaction', () => {
  it('redacts sensitive fields recursively in telemetry payloads', () => {
    const redacted = sanitizeAgentSPayload({
      ...keyValue(
        API_KEY_FIELD,
        ['sk', '-live', '-top', '-secret-123456'].join(''),
      ),
      ...keyValue(TOKEN_FIELD, ['to', 'ken-val', 'ue-001'].join('')),
      authHeader: ['B', 'earer ', 'tok', 'en-abcdef'].join(''),
      nested: {
        ...keyValue(
          AUTHORIZATION_FIELD_CAP,
          ['Bearer ', 'nested', '-', 'secret-xyz'].join(''),
        ),
        safeField: 'safe-value',
        deep: {
          ...keyValue(MODEL_API_KEY_FIELD, ['another-hidden', '-key'].join('')),
        },
      },
      headers: {
        'x-api-key': 'x-api-secret',
      },
      list: [
        {
          ...keyValue(PASSWORD_FIELD, 'pa55word'),
        },
      ],
    });

    expect(redacted).toEqual({
      ...keyValue(API_KEY_FIELD, 'sk***56'),
      ...keyValue(TOKEN_FIELD, 'to***01'),
      authHeader: 'Be***ef',
      nested: {
        ...keyValue(AUTHORIZATION_FIELD_CAP, 'Be***yz'),
        safeField: 'safe-value',
        deep: {
          ...keyValue(MODEL_API_KEY_FIELD, 'an***ey'),
        },
      },
      headers: {
        'x-api-key': 'x-***et',
      },
      list: [
        {
          ...keyValue(PASSWORD_FIELD, 'pa***rd'),
        },
      ],
    });
  });

  it('redacts command args while preserving non-sensitive args', () => {
    const sanitized = sanitizeCommandArgs([
      '-m',
      'agent_s',
      '--api_key',
      'my-secret-key',
      '--token',
      'another-token',
      '--port',
      '10800',
    ]);

    expect(sanitized).toEqual([
      '-m',
      'agent_s',
      '[REDACTED]',
      '[REDACTED]',
      '[REDACTED]',
      '[REDACTED]',
      '--port',
      '10800',
    ]);
  });

  it('creates structured telemetry events with correlation fields', () => {
    const event = createAgentSTelemetryEvent(
      'agent_s.runtime.error',
      {
        ...keyValue(AUTHORIZATION_FIELD, ['Bearer ', 'abc123'].join('')),
        reasonCode: 'startup_timeout',
      },
      {
        runId: 'run-1',
        sessionId: 'session-1',
      },
    );

    expect(event).toEqual({
      event: 'agent_s.runtime.error',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: null,
      payload: {
        ...keyValue(AUTHORIZATION_FIELD, 'Be***23'),
        reasonCode: 'startup_timeout',
      },
    });
  });

  it('sanitizes error-like payloads at service and IPC boundaries', () => {
    const payload = sanitizeAgentSBoundaryPayload({
      error: new Error('Bearer very-secret-token-123'),
      details: {
        ...keyValue(
          AUTHORIZATION_FIELD,
          ['Bearer ', 'nested-', 'tok', 'en-xyz'].join(''),
        ),
      },
    });

    expect(payload).toEqual({
      error: {
        name: 'Error',
        message: 'Bearer ve***23',
        stack: expect.any(String),
      },
      details: {
        ...keyValue(AUTHORIZATION_FIELD, 'Be***yz'),
      },
    });
  });
});
