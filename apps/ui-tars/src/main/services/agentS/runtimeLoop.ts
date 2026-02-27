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
} from '@main/store/safetyPolicy';
import { IMAGE_PLACEHOLDER } from '@ui-tars/shared/constants';
import { ShareVersion, StatusEnum, type Message } from '@ui-tars/shared/types';
import {
  type ExecuteOutput,
  type ExecuteParams,
  type ScreenshotOutput,
} from '@ui-tars/sdk/core';
import { Jimp } from 'jimp';

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

class AgentSRuntimeError extends Error {
  constructor(
    readonly payload: AgentSRuntimeErrorPayload,
    readonly details?: unknown,
  ) {
    super(payload.message);
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

const normalizeTurnTimeoutMs = (settings: LocalStore): number => {
  if (
    typeof settings.loopIntervalInMs !== 'number' ||
    !Number.isFinite(settings.loopIntervalInMs)
  ) {
    return AGENT_S_SAFE_DEFAULT_TURN_TIMEOUT_MS;
  }

  return Math.min(
    AGENT_S_SAFE_MAX_TURN_TIMEOUT_MS,
    Math.max(
      AGENT_S_SAFE_MIN_TURN_TIMEOUT_MS,
      Math.floor(settings.loopIntervalInMs),
    ),
  );
};

const readImageSize = async (
  base64: string,
): Promise<{ width: number; height: number }> => {
  const image = await Jimp.fromBuffer(Buffer.from(base64, 'base64'));
  return {
    width: image.bitmap.width,
    height: image.bitmap.height,
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
  params: {
    endpoint: string;
    instruction: string;
    screenshot: ScreenshotOutput;
    screenWidth: number;
    screenHeight: number;
    turnTimeoutMs: number;
    providerConfig: ReturnType<typeof mapProviderToAgentSConfig>;
    sessionHistoryMessages: Message[];
    step: number;
  },
): Promise<SidecarPredictionResult> => {
  const controller = new AbortController();
  const timeout = deps.setTimeout(() => {
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
      throw runtimeError({
        code: 'AGENT_S_TURN_TIMEOUT',
        message: `Agent-S turn timed out in ${params.turnTimeoutMs}ms`,
        step: params.step,
      });
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
  const turnTimeoutMs = normalizeTurnTimeoutMs(args.settings);
  const providerConfig = mapProviderToAgentSConfig(args.settings);

  logger.info('[agentS runtime] using provider config', {
    provider: providerConfig.provider,
    model: providerConfig.model,
    config: redactSensitiveConfig(providerConfig),
  });

  appendState(args.setState, args.getState, {
    status: StatusEnum.RUNNING,
    restUserData: buildRuntimeMeta({
      instruction: args.instruction,
      modelName: providerConfig.model,
      now: deps.now(),
    }),
  });

  setAgentSActive(true);

  try {
    const sidecarStatus = await deps.sidecarManager.health({ probe: true });
    if (!sidecarStatus.healthy || !sidecarStatus.endpoint) {
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
      const screenshot = await args.operator.screenshot();
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

      const prediction = await requestSidecarPrediction(deps, {
        endpoint: sidecarStatus.endpoint,
        instruction: args.instruction,
        screenshot,
        screenWidth: width,
        screenHeight: height,
        turnTimeoutMs,
        providerConfig,
        sessionHistoryMessages: args.sessionHistoryMessages,
        step,
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

      const executeOutput = await args.operator.execute({
        prediction: prediction.predictionText,
        parsedPrediction: translated.parsed,
        screenWidth: width,
        screenHeight: height,
        scaleFactor: screenshot.scaleFactor,
        factors: [1, 1],
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
    }

    throw runtimeError({
      code: 'AGENT_S_MAX_STEPS_REACHED',
      message: `Agent-S runtime reached max steps (${maxSteps})`,
      step: maxSteps,
    });
  } catch (error) {
    const runtimePayload: AgentSRuntimeErrorPayload =
      error instanceof AgentSRuntimeError
        ? error.payload
        : {
            code: 'AGENT_S_TURN_REQUEST_FAILED',
            message: error instanceof Error ? error.message : String(error),
            step: 0,
          };

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
        correlation: args.correlation,
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
        correlation: args.correlation,
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
