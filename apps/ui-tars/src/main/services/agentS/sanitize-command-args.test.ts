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

import { sanitizeCommandArgs } from './telemetry';

describe('sanitizeCommandArgs', () => {
  it('keeps sensitive flag names visible and redacts only the next value', () => {
    expect(sanitizeCommandArgs(['--api-key', 'secret'])).toEqual([
      '--api-key',
      '[REDACTED]',
    ]);
  });

  it('keeps path-like values containing auth substrings when no sensitive flag precedes them', () => {
    expect(
      sanitizeCommandArgs([
        '--model-path',
        '/usr/local/share/auth-provider/model.bin',
      ]),
    ).toEqual(['--model-path', '/usr/local/share/auth-provider/model.bin']);
  });

  it('keeps inline sensitive flag names visible while redacting their values', () => {
    expect(sanitizeCommandArgs(['--api-key=secret'])).toEqual([
      '--api-key=[REDACTED]',
    ]);
  });
});
