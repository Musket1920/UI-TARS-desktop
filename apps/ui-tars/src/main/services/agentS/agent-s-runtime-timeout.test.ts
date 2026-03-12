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
import {
  AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS,
  AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
  AGENT_S_SAFE_MIN_TURN_TIMEOUT_MS,
} from '@main/store/safetyPolicy';
import { type LocalStore } from '@main/store/types';
import { normalizeTurnTimeoutMs } from './runtimeLoop';

const createSettings = (overrides: Partial<LocalStore> = {}): LocalStore =>
  ({ ...overrides }) as LocalStore;

describe('normalizeTurnTimeoutMs', () => {
  it('uses a production-safe Agent-S timeout default and max', () => {
    expect(AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS).toBe(10_000);
    expect(AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS).toBe(30_000);
  });

  it('clamps the dedicated agentSTurnTimeoutMs within safe bounds', () => {
    const highTimeout = createSettings({ agentSTurnTimeoutMs: 60_000 });
    expect(normalizeTurnTimeoutMs(highTimeout)).toBe(
      AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
    );

    const lowTimeout = createSettings({ agentSTurnTimeoutMs: 25 });
    expect(normalizeTurnTimeoutMs(lowTimeout)).toBe(
      AGENT_S_SAFE_MIN_TURN_TIMEOUT_MS,
    );
  });

  it('falls back to the safe default when agentSTurnTimeoutMs is missing', () => {
    const baseline = createSettings({ loopIntervalInMs: 50 });
    const highLoop = createSettings({ loopIntervalInMs: 30_000 });

    expect(normalizeTurnTimeoutMs(baseline)).toBe(
      AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS,
    );
    expect(normalizeTurnTimeoutMs(highLoop)).toBe(
      AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS,
    );
  });
});
