import { describe, expect, it, vi } from 'vitest';

import {
  AgentSSidecarMode,
  EngineMode,
  Operator,
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
  getAgentSPersistEffectInputs,
  getPersistedAgentSFormValues,
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
    vlmBaseUrl: 'https://vlm.example.com',
    vlmApiKey: 'test-key',
    vlmModelName: 'ui-tars-test',
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
    vlmBaseUrl: 'https://vlm.example.com',
    vlmApiKey: 'test-key',
    vlmModelName: 'ui-tars-test',
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

  it('does not publish fulfilled results after stop', async () => {
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

    expect(setLoadingStatus).toHaveBeenCalledTimes(1);
    expect(setLoadingStatus).toHaveBeenCalledWith(true);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('does not clear state after stop when fetch fails', async () => {
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

    expect(setLoadingStatus).toHaveBeenCalledTimes(1);
    expect(setLoadingStatus).toHaveBeenCalledWith(true);
    expect(onError).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
