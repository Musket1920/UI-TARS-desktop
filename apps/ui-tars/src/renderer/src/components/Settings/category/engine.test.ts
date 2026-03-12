import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentSSidecarMode,
  EngineMode,
  Operator,
  VLMConnectionMode,
  type LocalStore,
} from '../../../../../main/store/types';

vi.mock('@main/store/types', () => ({
  AgentSSidecarMode: {
    Embedded: 'embedded',
    Remote: 'remote',
  },
  EngineMode: {
    UITARS: 'ui-tars',
    AgentS: 'agent-s',
  },
  VLMConnectionMode: {
    Managed: 'managed',
    LocalhostOpenAICompatible: 'localhost-openai-compatible',
  },
  Operator: {
    LocalComputer: 'Local Computer Operator',
  },
}));

vi.mock('@renderer/utils', () => ({
  cn: (...values: Array<string | undefined | null | false>) =>
    values.filter(Boolean).join(' '),
}));

vi.mock('@renderer/api', () => ({
  api: {
    getAgentSHealth: vi.fn(),
    getAgentRuntimeStatus: vi.fn(),
  },
}));

vi.mock('@renderer/hooks/useSetting', () => ({
  useSetting: () => ({
    settings: {},
    updateSetting: vi.fn(),
  }),
}));

vi.mock('@renderer/components/ui/alert', () => ({
  Alert: () => null,
  AlertDescription: () => null,
  AlertTitle: () => null,
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: () => null,
}));

vi.mock('@renderer/components/ui/form', () => ({
  Form: () => null,
  FormControl: () => null,
  FormField: () => null,
  FormItem: () => null,
  FormLabel: () => null,
  FormMessage: () => null,
}));

vi.mock('@renderer/components/ui/select', () => ({
  Select: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

vi.mock('@renderer/components/ui/input', () => ({
  Input: () => null,
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: () => null,
}));

vi.mock('@renderer/components/ui/separator', () => ({
  Separator: () => null,
}));

vi.mock('lucide-react', () => ({
  Loader2: () => null,
  RefreshCcw: () => null,
  ShieldCheck: () => null,
  ShieldOff: () => null,
}));

import {
  createAgentSStatusLoader,
  getAgentSModeChangePersistDelta,
  createSettledAgentSFieldPersistScheduler,
  getAgentSPersistEffectInputs,
  getPersistedAgentSFormValues,
  shouldResetAgentSFormValues,
} from './engine';

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
};

describe('Agent-S settings form reset trigger', () => {
  const persistedAgentSSettings: LocalStore = {
    vlmConnectionMode: VLMConnectionMode.Managed,
    vlmBaseUrl: 'https://vlm.example.com',
    vlmApiKey: 'test-key',
    vlmModelName: 'ui-tars-test',
    useResponsesApi: false,
    operator: Operator.LocalComputer,
    engineMode: EngineMode.AgentS,
    agentSSidecarMode: AgentSSidecarMode.Remote,
    agentSSidecarUrl: 'https://sidecar.example.com',
    agentSSidecarPort: 54321,
  };

  it('stays stable when unrelated persisted settings change', () => {
    const withUnrelatedChange: LocalStore = {
      ...persistedAgentSSettings,
      language: 'en',
    };

    expect(getPersistedAgentSFormValues(withUnrelatedChange)).toEqual(
      getPersistedAgentSFormValues(persistedAgentSSettings),
    );
  });

  it('changes when persisted Agent-S values change externally', () => {
    const externalAgentSChange: LocalStore = {
      ...persistedAgentSSettings,
      agentSSidecarPort: 60000,
    };

    expect(getPersistedAgentSFormValues(externalAgentSChange)).toEqual({
      engineMode: EngineMode.AgentS,
      agentSSidecarMode: AgentSSidecarMode.Remote,
      agentSSidecarUrl: 'https://sidecar.example.com',
      agentSSidecarPort: '60000',
    });
    expect(getPersistedAgentSFormValues(externalAgentSChange)).not.toEqual(
      getPersistedAgentSFormValues(persistedAgentSSettings),
    );
  });
});

describe('Agent-S settings persist effect inputs', () => {
  const persistedAgentSSettings: LocalStore = {
    vlmConnectionMode: VLMConnectionMode.Managed,
    vlmBaseUrl: 'https://vlm.example.com',
    vlmApiKey: 'test-key',
    vlmModelName: 'ui-tars-test',
    useResponsesApi: false,
    operator: Operator.LocalComputer,
    engineMode: EngineMode.AgentS,
    agentSSidecarMode: AgentSSidecarMode.Remote,
    agentSSidecarUrl: 'https://sidecar.example.com',
    agentSSidecarPort: 54321,
  };

  it('stays stable when unrelated persisted settings change', () => {
    const baseInputs = getAgentSPersistEffectInputs({
      hasPersistedSettings: true,
      ...getPersistedAgentSFormValues(persistedAgentSSettings),
    });
    const withUnrelatedChange = getAgentSPersistEffectInputs({
      hasPersistedSettings: true,
      ...getPersistedAgentSFormValues({
        ...persistedAgentSSettings,
        language: 'en',
      }),
    });

    expect(withUnrelatedChange).toEqual(baseInputs);
  });

  it('changes when persisted Agent-S values change externally', () => {
    const baseInputs = getAgentSPersistEffectInputs({
      hasPersistedSettings: true,
      ...getPersistedAgentSFormValues(persistedAgentSSettings),
    });
    const externalAgentSChange = getAgentSPersistEffectInputs({
      hasPersistedSettings: true,
      ...getPersistedAgentSFormValues({
        ...persistedAgentSSettings,
        agentSSidecarPort: 60000,
      }),
    });

    expect(externalAgentSChange).not.toEqual(baseInputs);
  });
});

describe('getAgentSModeChangePersistDelta', () => {
  it('flushes sidecar URL and port atomically when a mode change happens mid-edit', () => {
    expect(
      getAgentSModeChangePersistDelta({
        nextValues: {
          engineMode: EngineMode.AgentS,
          agentSSidecarMode: AgentSSidecarMode.Remote,
          agentSSidecarUrl: ' https://draft-sidecar.example.com ',
          agentSSidecarPort: '65432',
        },
        latestSettings: {
          engineMode: EngineMode.UITARS,
          agentSSidecarMode: AgentSSidecarMode.Embedded,
          agentSSidecarUrl: 'https://persisted-sidecar.example.com',
          agentSSidecarPort: 54321,
        },
      }),
    ).toEqual({
      engineMode: EngineMode.AgentS,
      agentSSidecarMode: AgentSSidecarMode.Remote,
      agentSSidecarUrl: 'https://draft-sidecar.example.com',
      agentSSidecarPort: 65432,
    });
  });

  it('keeps ordinary URL and port edits on the debounced path when modes are unchanged', () => {
    expect(
      getAgentSModeChangePersistDelta({
        nextValues: {
          engineMode: EngineMode.AgentS,
          agentSSidecarMode: AgentSSidecarMode.Remote,
          agentSSidecarUrl: 'https://draft-sidecar.example.com',
          agentSSidecarPort: '65432',
        },
        latestSettings: {
          engineMode: EngineMode.AgentS,
          agentSSidecarMode: AgentSSidecarMode.Remote,
          agentSSidecarUrl: 'https://persisted-sidecar.example.com',
          agentSSidecarPort: 54321,
        },
      }),
    ).toBeNull();
  });
});

describe('shouldResetAgentSFormValues', () => {
  const previousPersistedValues = {
    engineMode: EngineMode.AgentS,
    agentSSidecarMode: AgentSSidecarMode.Embedded,
    agentSSidecarUrl: '',
    agentSSidecarPort: '',
  };

  it('skips reset when a local sidecar mode persist arrives before URL and port settle', () => {
    expect(
      shouldResetAgentSFormValues({
        previousPersistedValues,
        nextPersistedValues: {
          ...previousPersistedValues,
          agentSSidecarMode: AgentSSidecarMode.Remote,
        },
        pendingLocallyPersistedValues: {
          engineMode: EngineMode.AgentS,
          agentSSidecarMode: AgentSSidecarMode.Remote,
          agentSSidecarUrl: 'https://draft-sidecar.example.com',
          agentSSidecarPort: '65432',
        },
      }),
    ).toBe(false);
  });

  it('resets when persisted Agent-S fields change externally', () => {
    expect(
      shouldResetAgentSFormValues({
        previousPersistedValues,
        nextPersistedValues: {
          engineMode: EngineMode.AgentS,
          agentSSidecarMode: AgentSSidecarMode.Remote,
          agentSSidecarUrl: 'https://external-sidecar.example.com',
          agentSSidecarPort: '60000',
        },
        pendingLocallyPersistedValues: {
          engineMode: EngineMode.AgentS,
          agentSSidecarMode: AgentSSidecarMode.Remote,
          agentSSidecarUrl: 'https://draft-sidecar.example.com',
          agentSSidecarPort: '65432',
        },
      }),
    ).toBe(true);
  });
});

describe('createSettledAgentSFieldPersistScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists only the latest settled valid sidecar URL', async () => {
    let latestValue = 'https://sidecar.example.com';
    let persistedValue: string | undefined;
    const trigger = vi.fn().mockResolvedValue(true);
    const persistValue = vi.fn((value: string | undefined) => {
      persistedValue = value;
    });

    const scheduler = createSettledAgentSFieldPersistScheduler<
      string,
      string | undefined
    >({
      delayMs: 25,
      trigger,
      getLatestValue: () => latestValue,
      normalizeValue: (value) => (value === '' ? undefined : value.trim()),
      getPersistedValue: () => persistedValue,
      persistValue,
    });

    latestValue = 'https://sidecar.example.com/a';
    scheduler.schedule(latestValue);
    await vi.advanceTimersByTimeAsync(10);

    latestValue = 'https://sidecar.example.com/ab';
    scheduler.schedule(latestValue);
    await vi.advanceTimersByTimeAsync(10);

    latestValue = 'https://sidecar.example.com/abc';
    scheduler.schedule(latestValue);

    await vi.advanceTimersByTimeAsync(24);
    expect(trigger).not.toHaveBeenCalled();
    expect(persistValue).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(persistValue).toHaveBeenCalledTimes(1);
    expect(persistValue).toHaveBeenCalledWith(
      'https://sidecar.example.com/abc',
    );
  });

  it('skips stale async URL persistence when the form value changes mid-validation', async () => {
    let latestValue = 'https://sidecar.example.com';
    let persistedValue: string | undefined;
    const validation = createDeferred<boolean>();
    const persistValue = vi.fn((value: string | undefined) => {
      persistedValue = value;
    });

    const scheduler = createSettledAgentSFieldPersistScheduler<
      string,
      string | undefined
    >({
      delayMs: 25,
      trigger: () => validation.promise,
      getLatestValue: () => latestValue,
      normalizeValue: (value) => (value === '' ? undefined : value.trim()),
      getPersistedValue: () => persistedValue,
      persistValue,
    });

    scheduler.schedule(latestValue);
    await vi.advanceTimersByTimeAsync(25);

    latestValue = 'https://sidecar.example.com/next';
    validation.resolve(true);
    await Promise.resolve();

    expect(persistValue).not.toHaveBeenCalled();
  });

  it('normalizes a settled sidecar port input before persisting', async () => {
    let latestValue = '54321';
    let persistedValue: number | undefined;
    const persistValue = vi.fn((value: number | undefined) => {
      persistedValue = value;
    });

    const scheduler = createSettledAgentSFieldPersistScheduler<
      string,
      number | undefined
    >({
      delayMs: 25,
      trigger: vi.fn().mockResolvedValue(true),
      getLatestValue: () => latestValue,
      normalizeValue: (value) => (value === '' ? undefined : Number(value)),
      getPersistedValue: () => persistedValue,
      persistValue,
    });

    scheduler.schedule(latestValue);
    await vi.advanceTimersByTimeAsync(25);

    expect(persistValue).toHaveBeenCalledTimes(1);
    expect(persistValue).toHaveBeenCalledWith(54321);
  });
});

describe('createAgentSStatusLoader', () => {
  it('publishes fetched status while active', async () => {
    const setLoadingStatus = vi.fn();
    const setStatus = vi.fn();

    const loader = createAgentSStatusLoader({
      setLoadingStatus,
      setStatus,
      fetchStatus: async () => ({
        health: { status: 'healthy', engine: { mode: EngineMode.AgentS } },
        runtimeStatus: {
          engine: { runtime: 'agent-s' },
          status: 'running',
        },
      }),
    });

    await loader.run();

    expect(setLoadingStatus).toHaveBeenNthCalledWith(1, true);
    expect(setLoadingStatus).toHaveBeenNthCalledWith(2, false);
    expect(setStatus).toHaveBeenCalledWith({
      health: { status: 'healthy', engine: { mode: EngineMode.AgentS } },
      runtimeStatus: {
        engine: { runtime: 'agent-s' },
        status: 'running',
      },
    });
  });

  it('clears loading but does not publish fulfilled results after stop during await', async () => {
    const setLoadingStatus = vi.fn();
    const setStatus = vi.fn();
    const deferred = createDeferred<{
      health: { status: 'healthy'; engine: { mode: EngineMode } };
      runtimeStatus: {
        engine: { runtime: 'agent-s' };
        status: 'running';
      };
    }>();

    const loader = createAgentSStatusLoader({
      setLoadingStatus,
      setStatus,
      fetchStatus: () => deferred.promise,
    });

    const runPromise = loader.run();
    loader.stop();
    deferred.resolve({
      health: { status: 'healthy', engine: { mode: EngineMode.AgentS } },
      runtimeStatus: {
        engine: { runtime: 'agent-s' },
        status: 'running',
      },
    });

    await runPromise;

    expect(setLoadingStatus).toHaveBeenNthCalledWith(1, true);
    expect(setLoadingStatus).toHaveBeenNthCalledWith(2, false);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('clears loading but does not clear status after stop when fetch fails', async () => {
    const setLoadingStatus = vi.fn();
    const setStatus = vi.fn();
    const onError = vi.fn();
    const deferred = createDeferred<{
      health: { status: 'healthy'; engine: { mode: EngineMode } };
      runtimeStatus: {
        engine: { runtime: 'agent-s' };
        status: 'running';
      };
    }>();

    const loader = createAgentSStatusLoader({
      setLoadingStatus,
      setStatus,
      fetchStatus: () => deferred.promise,
      onError,
    });

    const runPromise = loader.run();
    loader.stop();
    deferred.reject(new Error('poll failed'));

    await runPromise;

    expect(setLoadingStatus).toHaveBeenNthCalledWith(1, true);
    expect(setLoadingStatus).toHaveBeenNthCalledWith(2, false);
    expect(onError).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
