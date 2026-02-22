/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { logger } from '@main/logger';

export type AgentSCorrelationIds = {
  runId?: string | null;
  sessionId?: string | null;
};

export type AgentSTelemetryEventName =
  | 'agent_s.sidecar.start'
  | 'agent_s.sidecar.health'
  | 'agent_s.sidecar.stop'
  | 'agent_s.engine.selected'
  | 'agent_s.runtime.error'
  | 'agent_s.fallback.triggered';

export type AgentSTelemetryEvent = {
  event: AgentSTelemetryEventName;
  runId: string | null;
  sessionId: string | null;
  payload: Record<string, unknown>;
};

type AgentSTelemetryLevel = 'info' | 'warn' | 'error';

const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|token|authorization|auth|secret|password|cookie|set-cookie|x[-_]?api[-_]?key)/i;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const SENSITIVE_ARG_PATTERN =
  /(api[-_]?key|token|authorization|auth|secret|password)/i;

const redactStringValue = (value: string): string => {
  if (value.length === 0) {
    return '[REDACTED]';
  }

  if (value.length <= 4) {
    return '*'.repeat(value.length);
  }

  return `${value.slice(0, 2)}***${value.slice(-2)}`;
};

const redactBearerToken = (value: string): string => {
  const bearerMatch = value.match(/^\s*Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) {
    return `Bearer ${redactStringValue(bearerMatch[1].trim())}`;
  }

  return value.replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]');
};

const redactSensitiveLeaf = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return redactStringValue(value);
  }

  return '[REDACTED]';
};

const sanitizeInternal = (value: unknown): unknown => {
  if (value instanceof Error) {
    return sanitizeInternal({
      name: value.name,
      message: value.message,
      stack: value.stack,
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeInternal(item));
  }

  if (value !== null && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};

    Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? redactSensitiveLeaf(entry)
        : sanitizeInternal(entry);
    });

    return redacted;
  }

  if (typeof value === 'string') {
    return redactBearerToken(value);
  }

  return value;
};

const sanitizeErrorLike = (error: unknown): unknown => {
  if (error instanceof Error) {
    return sanitizeInternal({
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
  }

  return sanitizeInternal(error);
};

export const sanitizeAgentSPayload = <T>(value: T): T => {
  return sanitizeInternal(value) as T;
};

export const sanitizeAgentSBoundaryPayload = <T>(value: T): T => {
  return sanitizeErrorLike(value) as T;
};

export const sanitizeCommandArgs = (args: string[]) => {
  const sanitized: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    const previous = index > 0 ? args[index - 1] : '';
    const shouldRedact =
      SENSITIVE_ARG_PATTERN.test(current) ||
      (/^--?/.test(previous) && SENSITIVE_ARG_PATTERN.test(previous));

    sanitized.push(shouldRedact ? '[REDACTED]' : current);
  }

  return sanitized;
};

export const createAgentSTelemetryEvent = (
  event: AgentSTelemetryEventName,
  payload: Record<string, unknown> = {},
  correlation: AgentSCorrelationIds = {},
): AgentSTelemetryEvent => {
  return {
    event,
    runId: correlation.runId ?? null,
    sessionId: correlation.sessionId ?? null,
    payload: sanitizeAgentSPayload(payload),
  };
};

export const emitAgentSTelemetry = (
  event: AgentSTelemetryEventName,
  payload: Record<string, unknown> = {},
  options: {
    level?: AgentSTelemetryLevel;
    correlation?: AgentSCorrelationIds;
  } = {},
) => {
  const entry = createAgentSTelemetryEvent(event, payload, options.correlation);
  const level = options.level ?? 'info';

  if (level === 'error') {
    logger.error('[agentS telemetry]', entry);
    return;
  }

  if (level === 'warn') {
    logger.warn('[agentS telemetry]', entry);
    return;
  }

  logger.info('[agentS telemetry]', entry);
};
