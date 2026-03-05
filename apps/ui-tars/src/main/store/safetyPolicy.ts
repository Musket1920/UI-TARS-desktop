/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { LocalStore } from './types';

export const AGENT_S_SAFE_MAX_STEPS = 200;
export const AGENT_S_SAFE_DEFAULT_MAX_STEPS = 100;
export const AGENT_S_SAFE_MIN_TURN_TIMEOUT_MS = 50;
export const AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS = 3_000;
export const AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS = 1_000;

const normalizeBoundedNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
};

export const enforceAgentSSafetyPolicy = (settings: LocalStore): LocalStore => {
  return {
    ...settings,
    agentSEnableLocalEnv: false,
    maxLoopCount: normalizeBoundedNumber(
      settings.maxLoopCount,
      AGENT_S_SAFE_DEFAULT_MAX_STEPS,
      1,
      AGENT_S_SAFE_MAX_STEPS,
    ),
    loopIntervalInMs: normalizeBoundedNumber(
      settings.loopIntervalInMs,
      AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS,
      AGENT_S_SAFE_MIN_TURN_TIMEOUT_MS,
      AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
    ),
  };
};
