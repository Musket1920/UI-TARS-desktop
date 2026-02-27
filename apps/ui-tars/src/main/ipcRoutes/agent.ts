/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { initIpc } from '@ui-tars/electron-ipc/main';
import { StatusEnum, Conversation, Message } from '@ui-tars/shared/types';
import { store } from '@main/store/create';
import { SettingStore } from '@main/store/setting';
import { runAgent } from '@main/services/runAgent';
import { showWindow } from '@main/window/index';

import { closeScreenMarker } from '@main/window/ScreenMarker';
import { GUIAgent } from '@ui-tars/sdk';
import { Operator } from '@ui-tars/sdk/core';
import { EngineMode, type AppState } from '@main/store/types';
import {
  isAgentSActive,
  isAgentSPaused,
  pauseAgentSRuntime,
  resetAgentSLifecycle,
  resumeAgentSRuntime,
  setAgentSActive,
} from '@main/services/agentS/lifecycle';
import {
  agentSSidecarManager,
  classifyAgentSFailureReason,
  type AgentSFallbackClass,
  type SidecarStatus,
} from '@main/services/agentS/sidecarManager';
import { sanitizeAgentSBoundaryPayload } from '@main/services/agentS/telemetry';

const t = initIpc.create();

type AgentSHealthStatus = 'healthy' | 'degraded' | 'offline';

type AgentRuntimeSelection = 'agent-s' | 'legacy';

type AgentSEngineStatus = {
  mode: EngineMode;
  runtime: AgentRuntimeSelection;
  active: boolean;
  paused: boolean;
  thinking: boolean;
};

type AgentSHealthRoutePayload = {
  status: AgentSHealthStatus;
  message: string;
  reasonCode: string;
  failureClass: AgentSFallbackClass | null;
  circuitBreaker: {
    state: 'closed' | 'open' | 'half_open';
    open: boolean;
    canProbe: boolean;
    nextProbeAt: number | null;
  };
  engine: AgentSEngineStatus;
  timestamp: number;
};

type AgentSControlStatus = 'idle' | 'running' | 'paused';

type AgentSControlRoutePayload = {
  status: AgentSControlStatus;
  engine: AgentSEngineStatus;
  controls: {
    canRun: boolean;
    canPause: boolean;
    canResume: boolean;
    canStop: boolean;
  };
  timestamp: number;
};

const resolveRuntimeSelection = (active: boolean): AgentRuntimeSelection => {
  return active ? 'agent-s' : 'legacy';
};

const buildHealthPresentation = (sidecarStatus: SidecarStatus) => {
  const reasonCode =
    sidecarStatus.reason ??
    (sidecarStatus.healthy ? 'ok' : 'sidecar_unhealthy');
  if (sidecarStatus.healthy) {
    return {
      status: 'healthy' as const,
      message: 'Agent-S is healthy.',
      reasonCode,
      failureClass: null,
    };
  }

  const failureClass = classifyAgentSFailureReason(reasonCode);

  if (!sidecarStatus.healthy && sidecarStatus.state === 'starting') {
    return {
      status: 'degraded' as const,
      message: 'Model loading... Legacy fallback is active.',
      reasonCode,
      failureClass,
    };
  }

  if (failureClass === 'timeout') {
    return {
      status: 'degraded' as const,
      message: 'Agent-S timed out. Legacy fallback is active.',
      reasonCode,
      failureClass,
    };
  }

  if (failureClass === 'unavailable') {
    const offline =
      sidecarStatus.state === 'stopped' || sidecarStatus.state === 'stopping';
    return {
      status: (offline ? 'offline' : 'degraded') as AgentSHealthStatus,
      message: offline
        ? 'Agent-S is unavailable. Legacy fallback is active.'
        : 'Agent-S is currently unavailable. Legacy fallback is active.',
      reasonCode,
      failureClass,
    };
  }

  if (failureClass === 'invalid_output') {
    return {
      status: 'degraded' as const,
      message: 'Agent-S returned invalid output. Legacy fallback is active.',
      reasonCode: 'INVALID_OUTPUT',
      failureClass,
    };
  }

  return {
    status: 'degraded' as const,
    message: 'Agent-S is degraded. Legacy fallback is active.',
    reasonCode,
    failureClass,
  };
};

const createEngineStatus = (): AgentSEngineStatus => {
  const settings = SettingStore.getStore();
  const { thinking } = store.getState();
  const active = isAgentSActive();
  const paused = isAgentSPaused();

  return {
    mode: settings.engineMode ?? EngineMode.UITARS,
    runtime: resolveRuntimeSelection(active),
    active,
    paused,
    thinking,
  };
};

export class GUIAgentManager {
  private static instance: GUIAgentManager;
  private currentAgent: GUIAgent<Operator> | null = null;

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  public static getInstance(): GUIAgentManager {
    if (!GUIAgentManager.instance) {
      GUIAgentManager.instance = new GUIAgentManager();
    }
    return GUIAgentManager.instance;
  }

  public setAgent(agent: GUIAgent<Operator>) {
    this.currentAgent = agent;
  }

  public getAgent(): GUIAgent<Operator> | null {
    return this.currentAgent;
  }

  public clearAgent() {
    this.currentAgent = null;
  }
}

export const agentRoute = t.router({
  getAgentSHealth: t.procedure.input<void>().handle(async () => {
    const sidecarStatus = await agentSSidecarManager
      .health({ probe: true })
      .catch(() => agentSSidecarManager.getStatus());
    const breaker = agentSSidecarManager.getCircuitBreakerStatus();
    const baseHealthView = buildHealthPresentation(sidecarStatus);
    const healthView =
      breaker.state === 'open'
        ? {
            status: 'degraded' as const,
            message:
              'Agent-S is temporarily bypassed after repeated failures. Legacy fallback is active.',
            reasonCode: 'circuit_breaker_open',
            failureClass:
              breaker.lastFailureClass ?? ('degraded_fallback' as const),
          }
        : baseHealthView;
    const payload: AgentSHealthRoutePayload = {
      status: healthView.status,
      message: healthView.message,
      reasonCode: healthView.reasonCode,
      failureClass: healthView.failureClass,
      circuitBreaker: {
        state: breaker.state,
        open: breaker.state === 'open',
        canProbe: breaker.canProbe,
        nextProbeAt: breaker.nextProbeAt,
      },
      engine: createEngineStatus(),
      timestamp: sidecarStatus.checkedAt,
    };

    return sanitizeAgentSBoundaryPayload(payload);
  }),
  getAgentRuntimeStatus: t.procedure.input<void>().handle(async () => {
    const engine = createEngineStatus();
    const status: AgentSControlStatus = engine.paused
      ? 'paused'
      : engine.active
        ? 'running'
        : 'idle';
    const payload: AgentSControlRoutePayload = {
      status,
      engine,
      controls: {
        canRun: !engine.thinking,
        canPause: engine.active && !engine.paused,
        canResume: engine.active && engine.paused,
        canStop: engine.thinking || engine.active,
      },
      timestamp: Date.now(),
    };

    return sanitizeAgentSBoundaryPayload(payload);
  }),
  runAgent: t.procedure.input<void>().handle(async () => {
    const { thinking } = store.getState();
    if (thinking) {
      return;
    }

    store.setState({
      abortController: new AbortController(),
      thinking: true,
      errorMsg: null,
      agentSPaused: false,
    });

    await runAgent(store.setState, store.getState);

    store.setState({ thinking: false });
  }),
  pauseRun: t.procedure.input<void>().handle(async () => {
    const guiAgent = GUIAgentManager.getInstance().getAgent();
    const hasGuiAgent = guiAgent instanceof GUIAgent;
    const { thinking } = store.getState();
    const runAgentS = isAgentSActive();
    const agentSPaused = isAgentSPaused();
    const patch: Partial<AppState> = {};

    if (hasGuiAgent) {
      guiAgent.pause();
    }

    if (!hasGuiAgent && runAgentS && !agentSPaused && pauseAgentSRuntime()) {
      patch.agentSPaused = true;
    }

    if (hasGuiAgent || thinking) {
      patch.thinking = false;
    }

    if (Object.keys(patch).length) {
      store.setState(patch);
    }
  }),
  resumeRun: t.procedure.input<void>().handle(async () => {
    const guiAgent = GUIAgentManager.getInstance().getAgent();
    const hasGuiAgent = guiAgent instanceof GUIAgent;
    const { thinking } = store.getState();
    const runAgentS = isAgentSActive();
    const agentSPaused = isAgentSPaused();
    const patch: Partial<AppState> = {};

    if (hasGuiAgent) {
      guiAgent.resume();
    }

    if (!hasGuiAgent && runAgentS && agentSPaused && resumeAgentSRuntime()) {
      patch.agentSPaused = false;
    }

    if (hasGuiAgent || thinking) {
      patch.thinking = false;
    }

    if (Object.keys(patch).length) {
      store.setState(patch);
    }
  }),
  stopRun: t.procedure.input<void>().handle(async () => {
    const { abortController } = store.getState();
    resetAgentSLifecycle();
    setAgentSActive(false);
    store.setState({
      status: StatusEnum.END,
      thinking: false,
      agentSPaused: false,
    });

    showWindow();

    abortController?.abort();
    const guiAgent = GUIAgentManager.getInstance().getAgent();
    if (guiAgent instanceof GUIAgent) {
      guiAgent.resume();
      guiAgent.stop();
    }

    closeScreenMarker();
  }),
  setInstructions: t.procedure
    .input<{ instructions: string }>()
    .handle(async ({ input }) => {
      store.setState({ instructions: input.instructions });
    }),
  setMessages: t.procedure
    .input<{ messages: Conversation[] }>()
    .handle(async ({ input }) => {
      store.setState({ messages: input.messages });
    }),
  setSessionHistoryMessages: t.procedure
    .input<{ messages: Message[] }>()
    .handle(async ({ input }) => {
      store.setState({ sessionHistoryMessages: input.messages });
    }),
  clearHistory: t.procedure.input<void>().handle(async () => {
    store.setState({
      status: StatusEnum.END,
      messages: [],
      thinking: false,
      errorMsg: null,
      instructions: '',
    });
  }),
});
