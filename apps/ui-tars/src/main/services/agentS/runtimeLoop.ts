/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { logger } from '@main/logger';
import { type ConversationWithSoM } from '@main/shared/types';
import { type AppState, type LocalStore } from '@main/store/types';
import {
  AGENT_S_SAFE_DEFAULT_MAX_STEPS,
  AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS,
  AGENT_S_SAFE_MAX_STEPS,
  AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
  AGENT_S_SAFE_MIN_TURN_TIMEOUT_MS,
  normalizeAgentSLoopIntervalMs,
} from '@main/store/safetyPolicy';
import { IMAGE_PLACEHOLDER } from '@ui-tars/shared/constants';
import { ShareVersion, StatusEnum, type Message } from '@ui-tars/shared/types';
import {
  type ExecuteOutput,
  type ExecuteParams,
  type ScreenshotOutput,
} from '@ui-tars/sdk/core';
import { translateAgentSAction } from './actionTranslator';
import {
  mapProviderToAgentSConfig,
  redactSensitiveConfig,
} from './providerMap';
import {
  type AgentSSidecarManager,
  agentSSidecarManager,
  classifyAgentSFailureReason,
  type SidecarFailureReason,
  type SidecarStatus,
} from './sidecarManager';
import {
  parseSidecarPredictionPayload,
  type SidecarPredictionResult,
} from './sidecarSchemas';
import { ensureAgentSNotPaused, setAgentSActive } from './lifecycle';
import {
  type AgentSCorrelationIds,
  emitAgentSTelemetry,
  sanitizeAgentSBoundaryPayload,
  sanitizeAgentSPayload,
} from './telemetry';

export type AgentSRuntimeErrorCode =
  | 'ACTION_NOT_ALLOWED'
  | 'AGENT_S_CONFIG_ERROR'
  | 'AGENT_S_OPERATOR_ERROR'
  | 'AGENT_S_OPERATOR_TIMEOUT'
  | 'AGENT_S_SIDECAR_UNHEALTHY'
  | 'AGENT_S_TURN_TIMEOUT'
  | 'AGENT_S_TURN_REQUEST_FAILED'
  | 'AGENT_S_PREDICTION_MALFORMED'
  | 'AGENT_S_TRANSLATION_FAILED'
  | 'AGENT_S_SCREENSHOT_INVALID'
  | 'AGENT_S_MAX_STEPS_REACHED';

const ACTION_ALLOWLIST = [
  'left_click',
  'double_click',
  'right_click',
  'drag',
  'type',
  'hotkey',
  'scroll',
  'wait',
  'finished',
  'call_user',
] as const;

const isAllowlistedAction = (
  action: unknown,
): action is (typeof ACTION_ALLOWLIST)[number] => {
  return (
    typeof action === 'string' &&
    (ACTION_ALLOWLIST as readonly string[]).includes(action)
  );
};

export type AgentSRuntimeErrorPayload = {
  code: AgentSRuntimeErrorCode;
  message: string;
  step: number;
  sidecarReason?: SidecarFailureReason;
  translationCode?: string;
};

export type AgentSRuntimeLoopResult = {
  status: StatusEnum;
  stepsExecuted: number;
  error?: AgentSRuntimeErrorPayload;
};

type AgentSSidecarLike = Pick<AgentSSidecarManager, 'health' | 'getStatus'>;

export type AgentSRuntimeOperator = {
  screenshot: () => Promise<ScreenshotOutput>;
  execute: (params: ExecuteParams) => Promise<ExecuteOutput>;
};

type AgentSRuntimeDependencies = {
  fetch: typeof fetch;
  sidecarManager: AgentSSidecarLike;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  now: () => number;
};

export type RunAgentSRuntimeLoopArgs = {
  setState: (state: AppState) => void;
  getState: () => AppState;
  settings: LocalStore;
  operator: AgentSRuntimeOperator;
  instruction: string;
  sessionHistoryMessages: Message[];
  correlation?: AgentSCorrelationIds;
  deps?: Partial<AgentSRuntimeDependencies>;
};

type SidecarPredictionRequestParams = {
  endpoint: string;
  instruction: string;
  screenshot: ScreenshotOutput;
  screenWidth: number;
  screenHeight: number;
  turnTimeoutMs: number;
  providerConfig: ReturnType<typeof mapProviderToAgentSConfig>;
  sessionHistoryMessages: Message[];
  step: number;
  abortSignal?: AbortSignal;
  correlation?: AgentSCorrelationIds;
};

class AgentSRuntimeError extends Error {
  constructor(
    readonly payload: AgentSRuntimeErrorPayload,
    readonly details?: unknown,
  ) {
    super(payload.message);
  }
}

class AgentSRuntimeStoppedError extends Error {
  constructor(readonly step: number) {
    super('Agent-S runtime stopped by user');
  }
}

const normalizeMaxSteps = (settings: LocalStore): number => {
  if (
    typeof settings.maxLoopCount !== 'number' ||
    !Number.isFinite(settings.maxLoopCount)
  ) {
    return AGENT_S_SAFE_DEFAULT_MAX_STEPS;
  }

  return Math.min(
    AGENT_S_SAFE_MAX_STEPS,
    Math.max(1, Math.floor(settings.maxLoopCount)),
  );
};

export const normalizeTurnTimeoutMs = (settings: LocalStore): number => {
  const timeoutValue = settings.agentSTurnTimeoutMs;

  if (typeof timeoutValue === 'number' && Number.isFinite(timeoutValue)) {
    return Math.min(
      AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
      Math.max(AGENT_S_SAFE_MIN_TURN_TIMEOUT_MS, Math.floor(timeoutValue)),
    );
  }

  return AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS;
};

const waitForLoopInterval = async (
  deps: Pick<AgentSRuntimeDependencies, 'setTimeout' | 'clearTimeout'>,
  intervalMs: number,
  abortSignal?: AbortSignal,
) => {
  if (intervalMs <= 0 || abortSignal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;

    const cleanup = () => {
      if (timeout !== null) {
        deps.clearTimeout(timeout);
      }
      abortSignal?.removeEventListener('abort', onAbort);
    };

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    const onAbort = () => {
      finish();
    };

    abortSignal?.addEventListener('abort', onAbort, { once: true });

    if (abortSignal?.aborted) {
      finish();
      return;
    }

    timeout = deps.setTimeout(() => {
      finish();
    }, intervalMs);

    if (abortSignal?.aborted) {
      finish();
    }
  });
};

const raceTurnOperation = async <T>(
  deps: Pick<AgentSRuntimeDependencies, 'setTimeout' | 'clearTimeout'>,
  params: {
    operation: Promise<T>;
    step: number;
    turnTimeoutMs: number;
    abortSignal?: AbortSignal;
    correlation?: AgentSCorrelationIds;
    telemetrySource: string;
    timeoutCode?: AgentSRuntimeErrorCode;
    timeoutMessage?: string;
  },
): Promise<T> => {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;

    const cleanup = () => {
      if (timeout !== null) {
        deps.clearTimeout(timeout);
      }
      params.abortSignal?.removeEventListener('abort', onAbort);
    };

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };

    const onAbort = () => {
      finish(() => {
        reject(new AgentSRuntimeStoppedError(params.step));
      });
    };

    params.abortSignal?.addEventListener('abort', onAbort, { once: true });

    if (params.abortSignal?.aborted) {
      onAbort();
      return;
    }

    timeout = deps.setTimeout(() => {
      void Promise.resolve().then(() => {
        if (settled) {
          return;
        }

        if (params.abortSignal?.aborted) {
          onAbort();
          return;
        }

        const timeoutCorrelation = params.correlation
          ? { ...params.correlation, turnId: String(params.step) }
          : params.correlation;

        emitAgentSTelemetry(
          'turn_timeout',
          {
            source: params.telemetrySource,
            timeoutMs: params.turnTimeoutMs,
            step: params.step,
          },
          {
            level: 'warn',
            correlation: timeoutCorrelation,
          },
        );

        finish(() => {
          reject(
            runtimeError({
              code: params.timeoutCode ?? 'AGENT_S_TURN_TIMEOUT',
              message:
                params.timeoutMessage ??
                `Agent-S turn timed out in ${params.turnTimeoutMs}ms`,
              step: params.step,
            }),
          );
        });
      });
    }, params.turnTimeoutMs);

    void params.operation.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error) => {
        finish(() => {
          reject(error);
        });
      },
    );
  });
};

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_IHDR_DATA_LENGTH = 13;
const PNG_DIMENSION_HEADER_LENGTH = 24;

const readImageSize = async (
  base64: string,
): Promise<{ width: number; height: number }> => {
  const buffer = Buffer.from(base64, 'base64');

  if (buffer.length < PNG_DIMENSION_HEADER_LENGTH) {
    throw new Error('PNG header is truncated');
  }

  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Screenshot is not a PNG');
  }

  if (buffer.readUInt32BE(8) !== PNG_IHDR_DATA_LENGTH) {
    throw new Error('PNG IHDR chunk is invalid');
  }

  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('PNG IHDR chunk is missing');
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
};

const runtimeError = (
  payload: AgentSRuntimeErrorPayload,
  details?: unknown,
): AgentSRuntimeError => {
  return new AgentSRuntimeError(payload, details);
};

const stringifyRuntimeError = (payload: AgentSRuntimeErrorPayload): string => {
  return JSON.stringify({
    source: 'agent_s.runtime',
    code: payload.code,
    message: payload.message,
    step: payload.step,
    sidecarReason: payload.sidecarReason,
    translationCode: payload.translationCode,
  });
};

const appendState = (
  setState: (state: AppState) => void,
  getState: () => AppState,
  patch: {
    status?: StatusEnum;
    error?: AgentSRuntimeErrorPayload;
    conversations?: ConversationWithSoM[];
    restUserData?: AppState['restUserData'];
  },
) => {
  const prev = getState();
  const nextMessages = patch.conversations?.length
    ? [...prev.messages, ...patch.conversations]
    : prev.messages;

  setState({
    ...prev,
    status: patch.status ?? prev.status,
    errorMsg: patch.error ? stringifyRuntimeError(patch.error) : null,
    restUserData: patch.restUserData ?? prev.restUserData,
    messages: nextMessages,
  });
};

const resolveStatusFromAction = (
  action: string,
  executeOutput: ExecuteOutput | undefined,
): StatusEnum => {
  if (action === 'call_user') {
    return StatusEnum.CALL_USER;
  }

  if (action === 'finished') {
    return StatusEnum.END;
  }

  if (executeOutput && 'status' in executeOutput && executeOutput.status) {
    return executeOutput.status;
  }

  return StatusEnum.RUNNING;
};

const requestSidecarPrediction = async (
  deps: AgentSRuntimeDependencies,
  params: SidecarPredictionRequestParams,
): Promise<SidecarPredictionResult> => {
  const controller = new AbortController();
  let abortCause: 'timeout' | 'user' | null = null;
  const handleExternalAbort = () => {
    if (!abortCause) {
      abortCause = 'user';
    }
    controller.abort();
  };

  if (params.abortSignal?.aborted) {
    handleExternalAbort();
  } else {
    params.abortSignal?.addEventListener('abort', handleExternalAbort, {
      once: true,
    });
  }

  const timeout = deps.setTimeout(() => {
    if (!abortCause) {
      abortCause = 'timeout';
    }
    controller.abort();
  }, params.turnTimeoutMs);

  try {
    const response = await deps.fetch(
      `${params.endpoint.replace(/\/$/, '')}/predict`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          instruction: params.instruction,
          observation: {
            screenshot: params.screenshot.base64,
            screenWidth: params.screenWidth,
            screenHeight: params.screenHeight,
            scaleFactor: params.screenshot.scaleFactor,
          },
          sessionHistoryMessages: params.sessionHistoryMessages,
          engineParamsForGeneration:
            params.providerConfig.engineParamsForGeneration,
          engineParamsForGrounding:
            params.providerConfig.engineParamsForGrounding,
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw runtimeError({
        code: 'AGENT_S_TURN_REQUEST_FAILED',
        message: `Agent-S sidecar request failed with status ${response.status}`,
        step: params.step,
      });
    }

    const payload = (await response.json().catch(() => null)) as unknown;
    const parsed = parseSidecarPredictionPayload(payload);

    if (!parsed) {
      throw runtimeError(
        {
          code: 'AGENT_S_PREDICTION_MALFORMED',
          message: 'Agent-S sidecar returned malformed prediction payload',
          step: params.step,
        },
        payload,
      );
    }

    return parsed;
  } catch (error) {
    if (controller.signal.aborted) {
      const externalAbortRequested = params.abortSignal?.aborted === true;

      if (externalAbortRequested || abortCause === 'user') {
        throw new AgentSRuntimeStoppedError(params.step);
      }

      if (abortCause === 'timeout') {
        const timeoutCorrelation = params.correlation
          ? { ...params.correlation, turnId: String(params.step) }
          : params.correlation;

        emitAgentSTelemetry(
          'turn_timeout',
          {
            source: 'agent_s.runtime.request',
            timeoutMs: params.turnTimeoutMs,
            step: params.step,
          },
          {
            level: 'warn',
            correlation: timeoutCorrelation,
          },
        );

        throw runtimeError({
          code: 'AGENT_S_TURN_TIMEOUT',
          message: `Agent-S turn timed out in ${params.turnTimeoutMs}ms`,
          step: params.step,
        });
      }
    }

    if (error instanceof AgentSRuntimeError) {
      throw error;
    }

    throw runtimeError(
      {
        code: 'AGENT_S_TURN_REQUEST_FAILED',
        message: error instanceof Error ? error.message : String(error),
        step: params.step,
      },
      error,
    );
  } finally {
    params.abortSignal?.removeEventListener('abort', handleExternalAbort);
    deps.clearTimeout(timeout);
  }
};

const buildRuntimeMeta = (params: {
  instruction: string;
  modelName: string;
  now: number;
}): AppState['restUserData'] => {
  return {
    version: ShareVersion.V1,
    instruction: params.instruction,
    systemPrompt: 'agent-s-runtime-loop',
    modelName: params.modelName,
    logTime: params.now,
  };
};

export const runAgentSRuntimeLoop = async (
  args: RunAgentSRuntimeLoopArgs,
): Promise<AgentSRuntimeLoopResult> => {
  const deps: AgentSRuntimeDependencies = {
    fetch,
    sidecarManager: agentSSidecarManager,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    now: Date.now,
    ...args.deps,
  };

  const maxSteps = normalizeMaxSteps(args.settings);
  const loopIntervalInMs = normalizeAgentSLoopIntervalMs(
    args.settings.loopIntervalInMs,
  );
  const turnTimeoutMs = normalizeTurnTimeoutMs(args.settings);

  try {
    const providerConfig = (() => {
      try {
        return mapProviderToAgentSConfig(args.settings);
      } catch (error) {
        throw runtimeError(
          {
            code: 'AGENT_S_CONFIG_ERROR',
            message: error instanceof Error ? error.message : String(error),
            step: 0,
          },
          error,
        );
      }
    })();

    logger.info('[agentS runtime] using provider config', {
      provider: providerConfig.provider,
      model: providerConfig.model,
      config: redactSensitiveConfig(providerConfig),
    });

    const sidecarStatus = await deps.sidecarManager.health({ probe: true });
    const treatTransientProbeFailureAsHealthy =
      sidecarStatus.transientProbeFailure === true && !!sidecarStatus.endpoint;
    if (
      (!sidecarStatus.healthy && !treatTransientProbeFailureAsHealthy) ||
      !sidecarStatus.endpoint
    ) {
      throw runtimeError(
        {
          code: 'AGENT_S_SIDECAR_UNHEALTHY',
          message: 'Agent-S sidecar is unhealthy or endpoint is unavailable',
          step: 0,
          sidecarReason: sidecarStatus.reason,
        },
        sidecarStatus,
      );
    }

    setAgentSActive(true);

    appendState(args.setState, args.getState, {
      status: StatusEnum.RUNNING,
      restUserData: buildRuntimeMeta({
        instruction: args.instruction,
        modelName: providerConfig.model,
        now: deps.now(),
      }),
    });

    for (let step = 1; step <= maxSteps; step += 1) {
      await ensureAgentSNotPaused(args.getState().abortController?.signal);

      if (args.getState().abortController?.signal.aborted) {
        appendState(args.setState, args.getState, {
          status: StatusEnum.USER_STOPPED,
        });
        return {
          status: StatusEnum.USER_STOPPED,
          stepsExecuted: step - 1,
        };
      }

      const turnStartedAt = deps.now();
      const screenshot = await raceTurnOperation(deps, {
        operation: args.operator.screenshot(),
        step,
        turnTimeoutMs,
        abortSignal: args.getState().abortController?.signal,
        correlation: args.correlation,
        telemetrySource: 'agent_s.runtime.screenshot',
        timeoutCode: 'AGENT_S_OPERATOR_TIMEOUT',
        timeoutMessage: `Agent-S operator timed out in ${turnTimeoutMs}ms`,
      });
      const { width, height } = await readImageSize(screenshot.base64).catch(
        (error) => {
          throw runtimeError(
            {
              code: 'AGENT_S_SCREENSHOT_INVALID',
              message:
                'Failed to decode screenshot dimensions for Agent-S turn',
              step,
            },
            error,
          );
        },
      );

      if (!width || !height) {
        throw runtimeError({
          code: 'AGENT_S_SCREENSHOT_INVALID',
          message: 'Screenshot dimensions are invalid',
          step,
        });
      }

      const screenshotConversation: ConversationWithSoM = {
        from: 'human',
        value: IMAGE_PLACEHOLDER,
        screenshotBase64: screenshot.base64,
        screenshotContext: {
          size: {
            width,
            height,
          },
          mime: 'image/png',
          scaleFactor: screenshot.scaleFactor,
        },
        timing: {
          start: turnStartedAt,
          end: deps.now(),
          cost: deps.now() - turnStartedAt,
        },
      };

      appendState(args.setState, args.getState, {
        status: StatusEnum.RUNNING,
        conversations: [screenshotConversation],
      });

      const currentSidecarStatus = deps.sidecarManager.getStatus();
      if (!currentSidecarStatus.healthy || !currentSidecarStatus.endpoint) {
        throw runtimeError(
          {
            code: 'AGENT_S_SIDECAR_UNHEALTHY',
            message: 'Agent-S sidecar is unhealthy or endpoint is unavailable',
            step,
            sidecarReason: currentSidecarStatus.reason,
          },
          currentSidecarStatus,
        );
      }

      const prediction = await requestSidecarPrediction(deps, {
        endpoint: currentSidecarStatus.endpoint,
        instruction: args.instruction,
        screenshot,
        screenWidth: width,
        screenHeight: height,
        turnTimeoutMs,
        providerConfig,
        sessionHistoryMessages: args.sessionHistoryMessages,
        step,
        abortSignal: args.getState().abortController?.signal,
        correlation: args.correlation
          ? { ...args.correlation, turnId: String(step) }
          : args.correlation,
      });

      const translated = translateAgentSAction(prediction.action);
      if (!translated.ok) {
        const translationBlocked =
          translated.code === 'TRANSLATION_UNSUPPORTED_ACTION';

        throw runtimeError(
          {
            code: translationBlocked
              ? 'ACTION_NOT_ALLOWED'
              : 'AGENT_S_TRANSLATION_FAILED',
            message: translated.message,
            step,
            translationCode: translationBlocked
              ? 'ACTION_NOT_ALLOWED'
              : translated.code,
          },
          sanitizeAgentSPayload(prediction),
        );
      }

      if (
        !isAllowlistedAction(translated.normalizedAction) ||
        !isAllowlistedAction(translated.parsed.action_type)
      ) {
        throw runtimeError(
          {
            code: 'ACTION_NOT_ALLOWED',
            message: `Agent-S action is not allowlisted: ${translated.parsed.action_type}`,
            step,
            translationCode: 'ACTION_NOT_ALLOWED',
          },
          sanitizeAgentSPayload(prediction),
        );
      }

      const modelConversation: ConversationWithSoM = {
        from: 'gpt',
        value: prediction.predictionText,
        predictionParsed: [translated.parsed],
        screenshotContext: {
          size: {
            width,
            height,
          },
          scaleFactor: screenshot.scaleFactor,
        },
        timing: {
          start: turnStartedAt,
          end: deps.now(),
          cost: deps.now() - turnStartedAt,
        },
      };

      appendState(args.setState, args.getState, {
        status: StatusEnum.RUNNING,
        conversations: [modelConversation],
      });

      const executeOutput = await raceTurnOperation(deps, {
        operation: args.operator
          .execute({
            prediction: prediction.predictionText,
            parsedPrediction: translated.parsed,
            screenWidth: width,
            screenHeight: height,
            scaleFactor: screenshot.scaleFactor,
            factors: [1, 1],
          })
          .catch((error) => {
            throw runtimeError(
              {
                code: 'AGENT_S_OPERATOR_ERROR',
                message: error instanceof Error ? error.message : String(error),
                step,
              },
              error,
            );
          }),
        step,
        turnTimeoutMs,
        abortSignal: args.getState().abortController?.signal,
        correlation: args.correlation,
        telemetrySource: 'agent_s.runtime.execute',
        timeoutCode: 'AGENT_S_OPERATOR_TIMEOUT',
        timeoutMessage: `Agent-S operator timed out in ${turnTimeoutMs}ms`,
      });

      const nextStatus = resolveStatusFromAction(
        translated.normalizedAction,
        executeOutput,
      );

      appendState(args.setState, args.getState, {
        status: nextStatus,
      });

      if (nextStatus !== StatusEnum.RUNNING) {
        return {
          status: nextStatus,
          stepsExecuted: step,
        };
      }

      if (step < maxSteps) {
        await waitForLoopInterval(
          deps,
          loopIntervalInMs,
          args.getState().abortController?.signal,
        );
      }
    }

    throw runtimeError({
      code: 'AGENT_S_MAX_STEPS_REACHED',
      message: `Agent-S runtime reached max steps (${maxSteps})`,
      step: maxSteps,
    });
  } catch (error) {
    if (error instanceof AgentSRuntimeStoppedError) {
      appendState(args.setState, args.getState, {
        status: StatusEnum.USER_STOPPED,
      });

      return {
        status: StatusEnum.USER_STOPPED,
        stepsExecuted: Math.max(error.step - 1, 0),
      };
    }

    const runtimePayload: AgentSRuntimeErrorPayload =
      error instanceof AgentSRuntimeError
        ? error.payload
        : {
            code: 'AGENT_S_TURN_REQUEST_FAILED',
            message: error instanceof Error ? error.message : String(error),
            step: 0,
          };
    const runtimeCorrelation = args.correlation
      ? { ...args.correlation, turnId: String(runtimePayload.step) }
      : args.correlation;

    logger.error(
      '[agentS runtime] turn failed',
      sanitizeAgentSBoundaryPayload({
        error: runtimePayload,
        details: error instanceof AgentSRuntimeError ? error.details : error,
      }),
    );

    emitAgentSTelemetry(
      'agent_s.runtime.error',
      {
        source: 'agent_s.runtime.loop',
        ...runtimePayload,
      },
      {
        level: 'error',
        correlation: runtimeCorrelation,
      },
    );
    emitAgentSTelemetry(
      'agent_s.fallback.triggered',
      {
        source: 'agent_s.runtime',
        reasonCode: runtimePayload.code,
        failureClass: classifyAgentSFailureReason(runtimePayload.code),
      },
      {
        level: 'warn',
        correlation: runtimeCorrelation,
      },
    );
    emitAgentSTelemetry(
      'engine_fallback_triggered',
      {
        source: 'agent_s.runtime',
        reasonCode: runtimePayload.code,
        failureClass: classifyAgentSFailureReason(runtimePayload.code),
      },
      {
        level: 'warn',
        correlation: runtimeCorrelation,
      },
    );

    appendState(args.setState, args.getState, {
      status: StatusEnum.ERROR,
      error: runtimePayload,
    });

    return {
      status: StatusEnum.ERROR,
      stepsExecuted: Math.max(runtimePayload.step, 0),
      error: runtimePayload,
    };
  } finally {
    setAgentSActive(false);
  }
};

export const toSidecarFailureStatus = (status: SidecarStatus) => {
  return {
    healthy: status.healthy,
    state: status.state,
    reason: status.reason,
    endpoint: status.endpoint,
  };
};
