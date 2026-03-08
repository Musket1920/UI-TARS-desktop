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

import { getPersistedAgentSFormValues } from './engine';

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
