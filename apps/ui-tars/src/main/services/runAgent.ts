/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'assert';
import { randomUUID } from 'node:crypto';

import { logger } from '@main/logger';
import { StatusEnum } from '@ui-tars/shared/types';
import { type ConversationWithSoM } from '@main/shared/types';
import { GUIAgent, type GUIAgentConfig } from '@ui-tars/sdk';
import { markClickPosition } from '@main/utils/image';
import { UTIOService } from '@main/services/utio';
import { NutJSElectronOperator } from '../agent/operator';
import {
  createRemoteBrowserOperator,
  RemoteComputerOperator,
} from '../remote/operators';
import {
  DefaultBrowserOperator,
  RemoteBrowserOperator,
} from '@ui-tars/operator-browser';
import { showPredictionMarker } from '@main/window/ScreenMarker';
import { SettingStore } from '@main/store/setting';
import {
  AppState,
  EngineMode,
  Operator,
  VLMConnectionMode,
} from '@main/store/types';
import { GUIAgentManager } from '../ipcRoutes/agent';
import { checkBrowserAvailability } from './browserCheck';
import {
  getModelVersion,
  getSpByModelVersion,
  beforeAgentRun,
  afterAgentRun,
  getLocalBrowserSearchEngine,
} from '../utils/agent';
import { FREE_MODEL_BASE_URL } from '../remote/shared';
import { getAuthHeader } from '../remote/auth';
import { ProxyClient } from '../remote/proxyClient';
import { UITarsModelConfig } from '@ui-tars/sdk/core';
import {
  agentSSidecarManager,
  classifyAgentSFailureReason,
} from './agentS/sidecarManager';
import {
  type AgentSCorrelationIds,
  emitAgentSTelemetry,
  sanitizeAgentSBoundaryPayload,
  sanitizeAgentSPayload,
} from './agentS/telemetry';
import { runAgentSRuntimeLoop } from './agentS/runtimeLoop';

const AGENT_S_DISPATCHER_FEATURE_FLAG_KEYS = [
  'AGENT_S_DISPATCHER_FEATURE_FLAG',
  'AGENT_S_FEATURE_FLAG',
] as const;

const isAgentSDispatcherFeatureEnabled = () => {
  const rawFlag = AGENT_S_DISPATCHER_FEATURE_FLAG_KEYS.map(
    (key) => process.env[key],
  ).find((value): value is string => typeof value === 'string');

  if (!rawFlag) {
    return true;
  }

  const normalized = rawFlag.trim().toLowerCase();
  return !['0', 'false', 'off', 'disabled', 'no'].includes(normalized);
};

const emitDispatcherFallbackTelemetry = (
  correlation: AgentSCorrelationIds | null,
  payload: Record<string, unknown>,
) => {
  if (!correlation) {
    return;
  }

  emitAgentSTelemetry(
    'agent_s.fallback.triggered',
    {
      source: 'agent_s.dispatcher',
      ...payload,
    },
    {
      level: 'warn',
      correlation,
    },
  );

  emitAgentSTelemetry(
    'engine_fallback_triggered',
    {
      source: 'agent_s.dispatcher',
      ...payload,
    },
    {
      level: 'warn',
      correlation,
    },
  );
};

const NON_CIRCUITABLE_RUNTIME_FAILURE_CODES = new Set<string>([
  'ACTION_NOT_ALLOWED',
  'AGENT_S_MAX_STEPS_REACHED',
  'AGENT_S_CONFIG_ERROR',
  'AGENT_S_SCREENSHOT_INVALID',
  'AGENT_S_OPERATOR_ERROR',
  'AGENT_S_OPERATOR_TIMEOUT',
  'AGENT_S_TRANSLATION_FAILED',
  'AGENT_S_PREDICTION_MALFORMED',
  'AGENT_S_TURN_REQUEST_CLIENT_ERROR',
]);

const shouldRecordRuntimeCircuitFailure = (reasonCode: string) => {
  return !NON_CIRCUITABLE_RUNTIME_FAILURE_CODES.has(reasonCode);
};

const isUsableAgentSSidecarStatus = (
  sidecarHealthStatus:
    | Awaited<ReturnType<typeof agentSSidecarManager.health>>
    | null
    | undefined,
): sidecarHealthStatus is Awaited<
  ReturnType<typeof agentSSidecarManager.health>
> & { endpoint: string } => {
  const treatTransientProbeFailureAsHealthy =
    sidecarHealthStatus?.transientProbeFailure === true &&
    !!sidecarHealthStatus.endpoint;

  return (
    !!sidecarHealthStatus?.endpoint &&
    (!!sidecarHealthStatus.healthy || treatTransientProbeFailureAsHealthy)
  );
};

export const runAgent = async (
  setState: (state: AppState) => void,
  getState: () => AppState,
) => {
  logger.info('runAgent');
  const settings = SettingStore.getStore();
  const { instructions, abortController } = getState();
  assert(instructions, 'instructions is required');

  const isAgentSMode = settings.engineMode === EngineMode.AgentS;
  const agentSFeatureEnabled = isAgentSDispatcherFeatureEnabled();
  const shouldAttemptAgentS = isAgentSMode && agentSFeatureEnabled;
  const runCorrelation: AgentSCorrelationIds | null = isAgentSMode
    ? {
        runId: randomUUID(),
        sessionId: randomUUID(),
      }
    : null;

  if (runCorrelation) {
    agentSSidecarManager.setTelemetryCorrelation(runCorrelation);
  }

  const language = settings.language ?? 'en';

  logger.info('settings.operator', settings.operator);

  const handleData: GUIAgentConfig<NutJSElectronOperator>['onData'] = async ({
    data,
  }) => {
    const lastConv = getState().messages[getState().messages.length - 1];
    const { status, conversations, ...restUserData } = data;
    logger.info('[onGUIAgentData] status', status, conversations.length);

    // add SoM to conversations
    const conversationsWithSoM: ConversationWithSoM[] = await Promise.all(
      conversations.map(async (conv) => {
        const { screenshotContext, predictionParsed } = conv;
        if (
          lastConv?.screenshotBase64 &&
          screenshotContext?.size &&
          predictionParsed
        ) {
          const screenshotBase64WithElementMarker = await markClickPosition({
            screenshotContext,
            base64: lastConv?.screenshotBase64,
            parsed: predictionParsed,
          }).catch((e) => {
            logger.error('[markClickPosition error]:', e);
            return '';
          });
          return {
            ...conv,
            screenshotBase64WithElementMarker,
          };
        }
        return conv;
      }),
    ).catch((e) => {
      logger.error('[conversationsWithSoM error]:', e);
      return conversations;
    });

    const {
      screenshotBase64,
      predictionParsed,
      screenshotContext,
      screenshotBase64WithElementMarker,
      ...rest
    } = conversationsWithSoM?.[conversationsWithSoM.length - 1] || {};
    logger.info(
      '[onGUIAgentData] ======data======\n',
      predictionParsed,
      screenshotContext,
      rest,
      status,
      '\n========',
    );

    if (
      settings.operator === Operator.LocalComputer &&
      predictionParsed?.length &&
      screenshotContext?.size &&
      !abortController?.signal?.aborted
    ) {
      showPredictionMarker(predictionParsed, screenshotContext);
    }

    setState({
      ...getState(),
      status,
      restUserData,
      messages: [...(getState().messages || []), ...conversationsWithSoM],
    });
  };

  let operatorType: 'computer' | 'browser' = 'computer';
  let operator:
    | NutJSElectronOperator
    | DefaultBrowserOperator
    | RemoteComputerOperator
    | RemoteBrowserOperator
    | null = null;

  let sidecarHealthStatus: Awaited<
    ReturnType<typeof agentSSidecarManager.health>
  > | null = null;
  let sidecarHealthProbeError: unknown = null;
  let circuitReasonCode: string | null = null;
  let dispatchCircuitStatus: ReturnType<
    typeof agentSSidecarManager.getCircuitBreakerStatus
  > | null = null;

  let agentSWasAttempted = false;
  let agentSRunLifecycleClosed = false;

  const closeAgentSRunLifecycleIfNeeded = () => {
    if (!agentSWasAttempted || agentSRunLifecycleClosed) {
      return;
    }

    afterAgentRun(settings.operator);
    agentSRunLifecycleClosed = true;
  };

  const initializeOperator = async (): Promise<
    | NutJSElectronOperator
    | DefaultBrowserOperator
    | RemoteComputerOperator
    | RemoteBrowserOperator
    | null
  > => {
    switch (settings.operator) {
      case Operator.LocalComputer:
        operator = new NutJSElectronOperator();
        operatorType = 'computer';
        break;
      case Operator.LocalBrowser:
        await checkBrowserAvailability();
        {
          const { browserAvailable } = getState();
          if (!browserAvailable) {
            setState({
              ...getState(),
              status: StatusEnum.ERROR,
              errorMsg:
                'Browser is not available. Please install Chrome and try again.',
            });
            return null;
          }

          operator = await DefaultBrowserOperator.getInstance(
            false,
            false,
            false,
            getState().status === StatusEnum.CALL_USER,
            getLocalBrowserSearchEngine(settings.searchEngineForBrowser),
          );
          operatorType = 'browser';
        }
        break;
      case Operator.RemoteComputer:
        operator = await RemoteComputerOperator.create();
        operatorType = 'computer';
        break;
      case Operator.RemoteBrowser:
        operator = await createRemoteBrowserOperator();
        operatorType = 'browser';
        break;
      default:
        break;
    }

    if (!operator) {
      throw new Error('Operator failed to initialize');
    }

    return operator;
  };

  try {
    const usesUnsupportedAgentSLocalhostMode =
      settings.vlmConnectionMode ===
        VLMConnectionMode.LocalhostOpenAICompatible &&
      settings.engineMode === EngineMode.AgentS;

    if (usesUnsupportedAgentSLocalhostMode) {
      throw new Error(
        '`localhost-openai-compatible` is only supported for legacy UI-TARS local operators',
      );
    }

    const initializedOperator = await initializeOperator();
    if (!initializedOperator) {
      return;
    }

    if (shouldAttemptAgentS) {
      const dispatchCircuit =
        await agentSSidecarManager.evaluateDispatchCircuit();
      dispatchCircuitStatus = dispatchCircuit.breaker;
      circuitReasonCode = dispatchCircuit.reasonCode;

      if (!dispatchCircuit.allowAgentS) {
        sidecarHealthStatus = dispatchCircuit.sidecarStatus;
      } else if (dispatchCircuit.sidecarStatus) {
        sidecarHealthStatus = dispatchCircuit.sidecarStatus;
        sidecarHealthProbeError = null;
      }
    }

    if (shouldAttemptAgentS && !sidecarHealthStatus && !circuitReasonCode) {
      sidecarHealthStatus = await agentSSidecarManager
        .health({ probe: true })
        .catch((error) => {
          sidecarHealthProbeError = error;
          return null;
        });
    }

    const canUseAgentSRuntime =
      shouldAttemptAgentS && isUsableAgentSSidecarStatus(sidecarHealthStatus);

    if (runCorrelation) {
      emitAgentSTelemetry(
        'agent_s.engine.selected',
        {
          engineMode: settings.engineMode,
          featureEnabled: agentSFeatureEnabled,
          selectedRuntime: canUseAgentSRuntime ? 'agent_s' : 'legacy',
          sidecarHealthy: sidecarHealthStatus?.healthy ?? null,
          sidecarState: sidecarHealthStatus?.state ?? null,
          sidecarReason: sidecarHealthStatus?.reason ?? null,
          operator: settings.operator,
          operatorType,
          provider: settings.vlmProvider,
          circuitBreakerState: dispatchCircuitStatus?.state ?? null,
        },
        { correlation: runCorrelation },
      );
    }

    if (canUseAgentSRuntime) {
      beforeAgentRun(settings.operator);
      agentSWasAttempted = true;

      const startTime = Date.now();
      const { sessionHistoryMessages } = getState();

      const runtimeResult = await runAgentSRuntimeLoop({
        setState,
        getState,
        settings,
        operator: initializedOperator,
        instruction: instructions,
        sessionHistoryMessages,
        correlation: runCorrelation ?? undefined,
      });

      logger.info(
        '[runAgent Agent-S total cost]: ',
        (Date.now() - startTime) / 1000,
        's',
      );

      if (runtimeResult.status !== StatusEnum.ERROR) {
        closeAgentSRunLifecycleIfNeeded();
        agentSSidecarManager.recordCircuitSuccess({ source: 'runtime' });

        if (runCorrelation) {
          agentSSidecarManager.setTelemetryCorrelation({
            runId: null,
            sessionId: null,
          });
        }

        return;
      }

      const runtimeFailureCode = runtimeResult.error?.code ?? 'runtime_error';
      const runtimeFailureClass =
        classifyAgentSFailureReason(runtimeFailureCode);
      const breakerAfterRuntimeFailure = shouldRecordRuntimeCircuitFailure(
        runtimeFailureCode,
      )
        ? (agentSSidecarManager.recordCircuitFailure({
            source: 'runtime',
            reasonCode: runtimeFailureCode,
          }) ??
          dispatchCircuitStatus ??
          agentSSidecarManager.getCircuitBreakerStatus())
        : (dispatchCircuitStatus ??
          agentSSidecarManager.getCircuitBreakerStatus());

      emitDispatcherFallbackTelemetry(runCorrelation, {
        reasonCode: runtimeFailureCode,
        failureClass: runtimeFailureClass,
        circuitBreakerState: breakerAfterRuntimeFailure.state,
        circuitConsecutiveFailures:
          breakerAfterRuntimeFailure.consecutiveFailures,
        operator: settings.operator,
        sidecarReason: sidecarHealthStatus?.reason ?? null,
      });

      setState({
        ...getState(),
        status: StatusEnum.RUNNING,
        errorMsg: null,
        agentSPaused: false,
      });
      // Fall through to legacy with agentSWasAttempted=true and lifecycle open
    } else if (isAgentSMode) {
      const dispatcherReasonCode = !agentSFeatureEnabled
        ? 'feature_flag_disabled'
        : (circuitReasonCode ??
          sidecarHealthStatus?.reason ??
          (sidecarHealthProbeError
            ? 'sidecar_health_probe_failed'
            : 'sidecar_unhealthy'));
      const failureClass = classifyAgentSFailureReason(dispatcherReasonCode);
      const shouldRecordDispatcherCircuitFailure =
        agentSFeatureEnabled &&
        dispatcherReasonCode !== 'circuit_breaker_open' &&
        !sidecarHealthStatus?.transientProbeFailure;
      const breakerAfterDispatchFailure = shouldRecordDispatcherCircuitFailure
        ? (agentSSidecarManager.recordCircuitFailure({
            source: 'dispatcher',
            reasonCode: dispatcherReasonCode,
          }) ??
          dispatchCircuitStatus ??
          agentSSidecarManager.getCircuitBreakerStatus())
        : (dispatchCircuitStatus ??
          agentSSidecarManager.getCircuitBreakerStatus());

      emitDispatcherFallbackTelemetry(runCorrelation, {
        reasonCode: dispatcherReasonCode,
        failureClass,
        circuitBreakerState: breakerAfterDispatchFailure?.state ?? null,
        circuitConsecutiveFailures:
          breakerAfterDispatchFailure?.consecutiveFailures ?? null,
        operator: settings.operator,
        sidecarState: sidecarHealthStatus?.state ?? null,
        sidecarHealthy: sidecarHealthStatus?.healthy ?? false,
        error:
          sidecarHealthProbeError instanceof Error
            ? sanitizeAgentSBoundaryPayload(sidecarHealthProbeError).message
            : sidecarHealthProbeError
              ? sanitizeAgentSBoundaryPayload(String(sidecarHealthProbeError))
              : undefined,
      });
    }

    // Legacy fallback path: neither Agent-S runtime was attempted nor succeeded
    let modelVersion = getModelVersion(settings.vlmProvider);
    let modelConfig: UITarsModelConfig = {
      baseURL: settings.vlmBaseUrl,
      apiKey: settings.vlmApiKey, // secretlint-disable-line @secretlint/secretlint-rule-pattern -- config field name, value comes from settings
      model: settings.vlmModelName,
      useResponsesApi: settings.useResponsesApi,
    };
    let modelAuthHdrs: Record<string, string> = {};

    if (
      settings.operator === Operator.RemoteComputer ||
      settings.operator === Operator.RemoteBrowser
    ) {
      const useResponsesApi =
        await ProxyClient.getRemoteVLMResponseApiSupport();
      modelConfig = {
        baseURL: FREE_MODEL_BASE_URL,
        apiKey: '', // secretlint-disable-line @secretlint/secretlint-rule-pattern -- empty placeholder, not a credential
        model: '',
        useResponsesApi,
      };
      modelAuthHdrs = await getAuthHeader();
      modelVersion = await ProxyClient.getRemoteVLMProvider();
    }

    const systemPrompt = getSpByModelVersion(
      modelVersion,
      language,
      operatorType,
    );

    const guiAgent = new GUIAgent({
      model: modelConfig,
      systemPrompt: systemPrompt,
      logger,
      signal: abortController?.signal,
      operator: initializedOperator,
      onData: handleData,
      onError: (params) => {
        const { error } = params;
        logger.error(
          '[onGUIAgentError]',
          sanitizeAgentSPayload({
            settings,
            error: {
              status: error?.status,
              message: error?.message,
            },
            correlation: runCorrelation,
          }),
        );
        if (runCorrelation) {
          emitAgentSTelemetry(
            'agent_s.runtime.error',
            {
              source: 'runAgent.onError',
              operator: settings.operator,
              status: error?.status,
              message: error?.message,
            },
            { level: 'error', correlation: runCorrelation },
          );
          emitAgentSTelemetry(
            'agent_s.fallback.triggered',
            {
              source: 'agent_s.runtime',
              reasonCode: 'runtime_error',
              operator: settings.operator,
            },
            { level: 'warn', correlation: runCorrelation },
          );
          emitAgentSTelemetry(
            'engine_fallback_triggered',
            {
              source: 'agent_s.runtime',
              reasonCode: 'runtime_error',
              operator: settings.operator,
            },
            { level: 'warn', correlation: runCorrelation },
          );
        }
        setState({
          ...getState(),
          status: StatusEnum.ERROR,
          errorMsg: JSON.stringify({
            status: error?.status,
            message: error?.message,
            stack: error?.stack,
          }),
        });
      },
      retry: {
        model: {
          maxRetries: 5,
        },
        screenshot: {
          maxRetries: 5,
        },
        execute: {
          maxRetries: 1,
        },
      },
      maxLoopCount: settings.maxLoopCount,
      loopIntervalInMs: settings.loopIntervalInMs,
      uiTarsVersion: modelVersion,
    });

    GUIAgentManager.getInstance().setAgent(guiAgent);
    UTIOService.getInstance().sendInstruction(instructions);

    const { sessionHistoryMessages } = getState();

    // Only call beforeAgentRun if we haven't already (i.e., Agent-S was not attempted)
    if (!agentSWasAttempted) {
      beforeAgentRun(settings.operator);
    }

    const startTime = Date.now();

    await guiAgent
      .run(instructions, sessionHistoryMessages, modelAuthHdrs)
      .catch((e) => {
        logger.error(
          '[runAgentLoop error]',
          sanitizeAgentSPayload({
            error: {
              message: e?.message,
              stack: e?.stack,
            },
            correlation: runCorrelation,
          }),
        );
        if (runCorrelation) {
          emitAgentSTelemetry(
            'agent_s.runtime.error',
            {
              source: 'runAgent.loop',
              operator: settings.operator,
              message: e?.message,
            },
            { level: 'error', correlation: runCorrelation },
          );
          emitAgentSTelemetry(
            'agent_s.fallback.triggered',
            {
              source: 'agent_s.runtime',
              reasonCode: 'run_loop_error',
              operator: settings.operator,
            },
            { level: 'warn', correlation: runCorrelation },
          );
          emitAgentSTelemetry(
            'engine_fallback_triggered',
            {
              source: 'agent_s.runtime',
              reasonCode: 'run_loop_error',
              operator: settings.operator,
            },
            { level: 'warn', correlation: runCorrelation },
          );
        }
        setState({
          ...getState(),
          status: StatusEnum.ERROR,
          errorMsg: e.message,
        });
      });

    logger.info(
      '[runAgent Total cost]: ',
      (Date.now() - startTime) / 1000,
      's',
    );

    if (agentSWasAttempted) {
      closeAgentSRunLifecycleIfNeeded();
    } else {
      afterAgentRun(settings.operator);
    }

    if (runCorrelation && isAgentSMode) {
      agentSSidecarManager.setTelemetryCorrelation({
        runId: null,
        sessionId: null,
      });
    }
  } catch (e) {
    logger.error('[runAgent try-catch error]', e);

    closeAgentSRunLifecycleIfNeeded();

    throw e;
  }
};
