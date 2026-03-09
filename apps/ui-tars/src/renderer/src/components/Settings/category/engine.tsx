/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import * as z from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@renderer/components/ui/alert';
import { Button } from '@renderer/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@renderer/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Input } from '@renderer/components/ui/input';
import { Badge } from '@renderer/components/ui/badge';
import { Separator } from '@renderer/components/ui/separator';
import { cn } from '@renderer/utils';
import { useSetting } from '@renderer/hooks/useSetting';
import { api } from '@renderer/api';
import {
  AgentSSidecarMode,
  EngineMode,
  type LocalStore,
} from '@main/store/types';
import { Loader2, RefreshCcw, ShieldCheck, ShieldOff } from 'lucide-react';

type AgentSHealthPayload = Awaited<ReturnType<typeof api.getAgentSHealth>>;
type AgentRuntimeStatusPayload = Awaited<
  ReturnType<typeof api.getAgentRuntimeStatus>
>;

type AgentSStatusSnapshot<THealth, TRuntimeStatus> = {
  health: THealth | null;
  runtimeStatus: TRuntimeStatus | null;
};

const formSchema = z.object({
  engineMode: z.nativeEnum(EngineMode),
  agentSSidecarMode: z.nativeEnum(AgentSSidecarMode),
  agentSSidecarUrl: z
    .union([z.string().url({ message: 'Enter a valid URL' }), z.literal('')])
    .optional(),
  agentSSidecarPort: z
    .string()
    .regex(/^\d*$/, { message: 'Port must be a number' })
    .refine((val) => val === '' || (Number(val) >= 1 && Number(val) <= 65535), {
      message: 'Port must be between 1 and 65535',
    })
    .optional(),
});

type FormValues = z.infer<typeof formSchema>;

type PersistedAgentSFormValues = Pick<
  FormValues,
  'engineMode' | 'agentSSidecarMode'
> & {
  agentSSidecarUrl: NonNullable<FormValues['agentSSidecarUrl']>;
  agentSSidecarPort: NonNullable<FormValues['agentSSidecarPort']>;
};

type AgentSPersistEffectInputs = PersistedAgentSFormValues & {
  hasPersistedSettings: boolean;
};

const PERSISTED_AGENT_S_FORM_FIELDS = [
  'engineMode',
  'agentSSidecarMode',
  'agentSSidecarUrl',
  'agentSSidecarPort',
] as const;

const HEALTH_BADGE_VARIANT: Record<
  AgentSHealthPayload['status'],
  'default' | 'destructive' | 'outline' | 'secondary'
> = {
  healthy: 'default',
  degraded: 'secondary',
  offline: 'destructive',
};

const STATUS_COPY: Record<AgentSHealthPayload['status'], string> = {
  healthy: 'Sidecar is healthy',
  degraded: 'Sidecar is reachable but degraded',
  offline: 'Sidecar is offline',
};

const toSidecarPortInputValue = (
  port: LocalStore['agentSSidecarPort'],
): NonNullable<FormValues['agentSSidecarPort']> => {
  return port === undefined ? '' : String(port);
};

const toPersistedSidecarPort = (
  port: FormValues['agentSSidecarPort'],
): LocalStore['agentSSidecarPort'] => {
  return port === undefined || port === '' ? undefined : Number(port);
};

export const getPersistedAgentSFormValues = (
  settings: Partial<LocalStore>,
): PersistedAgentSFormValues => {
  return {
    engineMode: settings.engineMode ?? EngineMode.UITARS,
    agentSSidecarMode: settings.agentSSidecarMode ?? AgentSSidecarMode.Embedded,
    agentSSidecarUrl: settings.agentSSidecarUrl ?? '',
    agentSSidecarPort: toSidecarPortInputValue(settings.agentSSidecarPort),
  };
};

export const getAgentSPersistEffectInputs = (
  inputs: AgentSPersistEffectInputs,
): AgentSPersistEffectInputs => {
  return inputs;
};

export const getAgentSModeChangePersistDelta = ({
  nextValues,
  latestSettings,
}: {
  nextValues: PersistedAgentSFormValues;
  latestSettings: Partial<LocalStore>;
}): Partial<LocalStore> | null => {
  const delta: Partial<LocalStore> = {};

  if (nextValues.engineMode !== latestSettings.engineMode) {
    delta.engineMode = nextValues.engineMode;
  }

  if (nextValues.agentSSidecarMode !== latestSettings.agentSSidecarMode) {
    delta.agentSSidecarMode = nextValues.agentSSidecarMode;
  }

  if (Object.keys(delta).length === 0) {
    return null;
  }

  const normalizedSidecarUrl =
    nextValues.agentSSidecarUrl === ''
      ? undefined
      : nextValues.agentSSidecarUrl.trim();
  const normalizedSidecarPort = toPersistedSidecarPort(
    nextValues.agentSSidecarPort,
  );

  if (normalizedSidecarUrl !== latestSettings.agentSSidecarUrl) {
    delta.agentSSidecarUrl = normalizedSidecarUrl;
  }

  if (normalizedSidecarPort !== latestSettings.agentSSidecarPort) {
    delta.agentSSidecarPort = normalizedSidecarPort;
  }

  return delta;
};

const hasMatchingPersistedAgentSFormValues = (
  left: PersistedAgentSFormValues,
  right: PersistedAgentSFormValues,
) => {
  return PERSISTED_AGENT_S_FORM_FIELDS.every(
    (field) => left[field] === right[field],
  );
};

export const shouldResetAgentSFormValues = ({
  previousPersistedValues,
  nextPersistedValues,
  pendingLocallyPersistedValues,
}: {
  previousPersistedValues: PersistedAgentSFormValues | null;
  nextPersistedValues: PersistedAgentSFormValues;
  pendingLocallyPersistedValues: PersistedAgentSFormValues | null;
}) => {
  if (previousPersistedValues === null) {
    return true;
  }

  const changedPersistedFields = PERSISTED_AGENT_S_FORM_FIELDS.filter(
    (field) => previousPersistedValues[field] !== nextPersistedValues[field],
  );

  if (changedPersistedFields.length === 0) {
    return false;
  }

  if (
    pendingLocallyPersistedValues &&
    changedPersistedFields.every(
      (field) =>
        pendingLocallyPersistedValues[field] === nextPersistedValues[field],
    )
  ) {
    return false;
  }

  return true;
};

const AGENT_S_FIELD_PERSIST_DELAY_MS = 300;

export const createSettledAgentSFieldPersistScheduler = <
  TValue,
  TPersistedValue,
>({
  delayMs = AGENT_S_FIELD_PERSIST_DELAY_MS,
  trigger,
  getLatestValue,
  normalizeValue,
  getPersistedValue,
  persistValue,
  scheduleTimeout = setTimeout,
  clearScheduledTimeout = clearTimeout,
}: {
  delayMs?: number;
  trigger: () => Promise<boolean>;
  getLatestValue: () => TValue;
  normalizeValue: (value: TValue) => TPersistedValue;
  getPersistedValue: () => TPersistedValue;
  persistValue: (value: TPersistedValue) => void;
  scheduleTimeout?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearScheduledTimeout?: (timeoutId: ReturnType<typeof setTimeout>) => void;
}) => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timeoutId === null) {
      return;
    }

    clearScheduledTimeout(timeoutId);
    timeoutId = null;
  };

  const schedule = (pendingValue: TValue) => {
    cancel();
    timeoutId = scheduleTimeout(() => {
      timeoutId = null;

      void (async () => {
        const isValid = await trigger();
        const latestValue = getLatestValue();

        if (!isValid || latestValue !== pendingValue) {
          return;
        }

        const normalizedValue = normalizeValue(pendingValue);

        if (normalizedValue !== getPersistedValue()) {
          persistValue(normalizedValue);
        }
      })();
    }, delayMs);
  };

  return {
    schedule,
    cancel,
  };
};

export const createAgentSStatusLoader = <THealth, TRuntimeStatus>({
  setLoadingStatus,
  setStatus,
  fetchStatus,
  onError,
}: {
  setLoadingStatus: (loading: boolean) => void;
  setStatus: (status: AgentSStatusSnapshot<THealth, TRuntimeStatus>) => void;
  fetchStatus: (options?: { forceProbe?: boolean }) => Promise<{
    health: THealth;
    runtimeStatus: TRuntimeStatus;
  }>;
  onError?: (error: unknown) => void;
}) => {
  let active = true;

  const run = async (options?: { forceProbe?: boolean }) => {
    if (!active) {
      return;
    }

    setLoadingStatus(true);

    try {
      const nextStatus = await fetchStatus(options);

      if (!active) {
        return;
      }

      setStatus(nextStatus);
    } catch (error) {
      if (!active) {
        return;
      }

      onError?.(error);
      setStatus({ health: null, runtimeStatus: null });
    } finally {
      if (active) {
        setLoadingStatus(false);
      }
    }
  };

  return {
    run,
    stop: () => {
      active = false;
    },
  };
};

export function EngineSettings({ className }: { className?: string }) {
  const { settings, updateSetting } = useSetting();
  const latestSettingsRef = useRef(settings);
  const previousPersistedAgentSFormValuesRef =
    useRef<PersistedAgentSFormValues | null>(null);
  const pendingLocallyPersistedAgentSFormValuesRef =
    useRef<PersistedAgentSFormValues | null>(null);
  const [health, setHealth] = useState<AgentSHealthPayload | null>(null);
  const [runtimeStatus, setRuntimeStatus] =
    useState<AgentRuntimeStatusPayload | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      engineMode: EngineMode.UITARS,
      agentSSidecarMode: AgentSSidecarMode.Embedded,
      agentSSidecarUrl: '',
      agentSSidecarPort: '',
    },
  });

  const [newEngineMode, newSidecarMode, newSidecarUrl, newSidecarPort] =
    form.watch([
      'engineMode',
      'agentSSidecarMode',
      'agentSSidecarUrl',
      'agentSSidecarPort',
    ]);
  const hasPersistedSettings = Object.keys(settings).length > 0;
  const persistedEngineMode = settings.engineMode ?? EngineMode.UITARS;
  const persistedSidecarMode =
    settings.agentSSidecarMode ?? AgentSSidecarMode.Embedded;
  const persistedSidecarUrl = settings.agentSSidecarUrl ?? '';
  const persistedSidecarPort = toSidecarPortInputValue(
    settings.agentSSidecarPort,
  );
  const persistedAgentSFormValues = useMemo(
    () => ({
      engineMode: persistedEngineMode,
      agentSSidecarMode: persistedSidecarMode,
      agentSSidecarUrl: persistedSidecarUrl,
      agentSSidecarPort: persistedSidecarPort,
    }),
    [
      persistedEngineMode,
      persistedSidecarMode,
      persistedSidecarUrl,
      persistedSidecarPort,
    ],
  );
  const persistEffectInputs = useMemo(
    () =>
      getAgentSPersistEffectInputs({
        hasPersistedSettings,
        engineMode: newEngineMode,
        agentSSidecarMode: newSidecarMode,
        agentSSidecarUrl: newSidecarUrl ?? '',
        agentSSidecarPort: newSidecarPort ?? '',
      }),
    [
      hasPersistedSettings,
      newEngineMode,
      newSidecarMode,
      newSidecarUrl,
      newSidecarPort,
    ],
  );

  useEffect(() => {
    latestSettingsRef.current = settings;
  }, [settings]);

  const persistSettingsDelta = useCallback(
    (delta: Partial<LocalStore>) => {
      const nextSettings = {
        ...latestSettingsRef.current,
        ...delta,
      };

      latestSettingsRef.current = nextSettings;
      pendingLocallyPersistedAgentSFormValuesRef.current =
        getPersistedAgentSFormValues(nextSettings);
      updateSetting(nextSettings);
    },
    [updateSetting],
  );

  const sidecarUrlPersistScheduler = useMemo(
    () =>
      createSettledAgentSFieldPersistScheduler<
        string,
        LocalStore['agentSSidecarUrl']
      >({
        trigger: () => form.trigger('agentSSidecarUrl'),
        getLatestValue: () => form.getValues('agentSSidecarUrl') ?? '',
        normalizeValue: (value) => (value === '' ? undefined : value.trim()),
        getPersistedValue: () => latestSettingsRef.current.agentSSidecarUrl,
        persistValue: (value) => {
          persistSettingsDelta({ agentSSidecarUrl: value });
        },
      }),
    [form, persistSettingsDelta],
  );

  const sidecarPortPersistScheduler = useMemo(
    () =>
      createSettledAgentSFieldPersistScheduler<
        string,
        LocalStore['agentSSidecarPort']
      >({
        trigger: () => form.trigger('agentSSidecarPort'),
        getLatestValue: () => form.getValues('agentSSidecarPort') ?? '',
        normalizeValue: (value) => toPersistedSidecarPort(value),
        getPersistedValue: () => latestSettingsRef.current.agentSSidecarPort,
        persistValue: (value) => {
          persistSettingsDelta({ agentSSidecarPort: value });
        },
      }),
    [form, persistSettingsDelta],
  );

  useEffect(() => {
    if (!hasPersistedSettings) {
      previousPersistedAgentSFormValuesRef.current = null;
      pendingLocallyPersistedAgentSFormValuesRef.current = null;
      return;
    }

    if (
      shouldResetAgentSFormValues({
        previousPersistedValues: previousPersistedAgentSFormValuesRef.current,
        nextPersistedValues: persistedAgentSFormValues,
        pendingLocallyPersistedValues:
          pendingLocallyPersistedAgentSFormValuesRef.current,
      })
    ) {
      form.reset(persistedAgentSFormValues);
    }

    previousPersistedAgentSFormValuesRef.current = persistedAgentSFormValues;

    if (
      pendingLocallyPersistedAgentSFormValuesRef.current &&
      hasMatchingPersistedAgentSFormValues(
        pendingLocallyPersistedAgentSFormValuesRef.current,
        persistedAgentSFormValues,
      )
    ) {
      pendingLocallyPersistedAgentSFormValuesRef.current = null;
    }
  }, [hasPersistedSettings, persistedAgentSFormValues, form]);

  useEffect(() => {
    if (!persistEffectInputs.hasPersistedSettings) {
      return;
    }

    const {
      engineMode: persistedEngineMode,
      agentSSidecarMode: persistedSidecarMode,
      agentSSidecarUrl: persistedSidecarUrl,
      agentSSidecarPort: persistedSidecarPort,
    } = persistEffectInputs;

    const persist = async () => {
      const modeChangePersistDelta = getAgentSModeChangePersistDelta({
        nextValues: {
          engineMode: persistedEngineMode,
          agentSSidecarMode: persistedSidecarMode,
          agentSSidecarUrl: persistedSidecarUrl,
          agentSSidecarPort: persistedSidecarPort,
        },
        latestSettings: latestSettingsRef.current,
      });

      if (modeChangePersistDelta) {
        sidecarUrlPersistScheduler.cancel();
        sidecarPortPersistScheduler.cancel();
        persistSettingsDelta(modeChangePersistDelta);
        return;
      }

      const normalizedSidecarUrl =
        persistedSidecarUrl === '' ? undefined : persistedSidecarUrl.trim();

      if (normalizedSidecarUrl !== latestSettingsRef.current.agentSSidecarUrl) {
        sidecarUrlPersistScheduler.schedule(persistedSidecarUrl);
      } else {
        sidecarUrlPersistScheduler.cancel();
      }

      const normalizedSidecarPort =
        toPersistedSidecarPort(persistedSidecarPort);

      if (
        normalizedSidecarPort !== latestSettingsRef.current.agentSSidecarPort
      ) {
        sidecarPortPersistScheduler.schedule(persistedSidecarPort);
      } else {
        sidecarPortPersistScheduler.cancel();
      }
    };

    void persist();

    return () => {
      sidecarUrlPersistScheduler.cancel();
      sidecarPortPersistScheduler.cancel();
    };
  }, [
    persistEffectInputs,
    persistSettingsDelta,
    sidecarUrlPersistScheduler,
    sidecarPortPersistScheduler,
  ]);

  const statusLoader = useMemo(
    () =>
      createAgentSStatusLoader<AgentSHealthPayload, AgentRuntimeStatusPayload>({
        setLoadingStatus: setIsLoadingStatus,
        setStatus: ({
          health: nextHealth,
          runtimeStatus: nextRuntimeStatus,
        }) => {
          setHealth(nextHealth);
          setRuntimeStatus(nextRuntimeStatus);
        },
        fetchStatus: async (options) => {
          const [healthPayload, runtimePayload] = await Promise.all([
            api.getAgentSHealth({ forceProbe: options?.forceProbe ?? false }),
            api.getAgentRuntimeStatus(),
          ]);

          return {
            health: healthPayload,
            runtimeStatus: runtimePayload,
          };
        },
        onError: (error) => {
          console.error('Failed to load Agent-S status', error);
        },
      }),
    [],
  );

  useEffect(() => {
    void statusLoader.run();
    const timer = setInterval(() => {
      void statusLoader.run();
    }, 15000);

    return () => {
      statusLoader.stop();
      clearInterval(timer);
    };
  }, [statusLoader]);

  const runtimeRuntimeLabel = useMemo(() => {
    if (!runtimeStatus) return 'Unknown';
    return runtimeStatus.engine.runtime === 'agent-s'
      ? 'Agent-S runtime active'
      : 'Legacy runtime in use';
  }, [runtimeStatus]);

  const fallbackNotice = useMemo(() => {
    if (!health || !runtimeStatus) return null;
    if (health.status === 'offline') {
      return 'Agent-S sidecar offline; legacy path will be used.';
    }
    if (runtimeStatus.engine.runtime === 'legacy') {
      return 'Agent-S selected but legacy runtime is active due to health or pause.';
    }
    return null;
  }, [health, runtimeStatus]);

  return (
    <div className={cn('space-y-4', className)}>
      <div className="space-y-2">
        <Form {...form}>
          <form className="space-y-6">
            <FormField
              control={form.control}
              name="engineMode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Engine Mode</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger
                        className="bg-white"
                        data-testid="engine-select"
                      >
                        <SelectValue placeholder="Select engine mode" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={EngineMode.UITARS}>
                        UI-TARS (Legacy)
                      </SelectItem>
                      <SelectItem value={EngineMode.AgentS}>
                        Agent-S (Sidecar)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Separator />

            <FormField
              control={form.control}
              name="agentSSidecarMode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Agent-S Sidecar Mode</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="bg-white">
                        <SelectValue placeholder="Select sidecar mode" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={AgentSSidecarMode.Embedded}>
                        Embedded (managed by app)
                      </SelectItem>
                      <SelectItem value={AgentSSidecarMode.Remote}>
                        Remote (existing sidecar)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {newSidecarMode === AgentSSidecarMode.Remote && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="agentSSidecarUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sidecar Base URL</FormLabel>
                      <FormControl>
                        <Input
                          className="bg-white"
                          placeholder="https://sidecar.example.com"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="agentSSidecarPort"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sidecar Port</FormLabel>
                      <FormControl>
                        <Input
                          className="bg-white"
                          placeholder="54321"
                          {...field}
                          value={field.value ?? ''}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}
          </form>
        </Form>
      </div>

      <div className="space-y-3 rounded-md border border-border bg-white/70 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {health?.status === 'healthy' ? (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            ) : (
              <ShieldOff className="h-4 w-4 text-amber-600" />
            )}
            <div>
              <p className="text-sm font-medium">Agent-S Sidecar</p>
              <p className="text-xs text-muted-foreground">Health & runtime</p>
            </div>
          </div>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => void statusLoader.run({ forceProbe: true })}
            disabled={isLoadingStatus}
          >
            {isLoadingStatus ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="h-4 w-4" />
            )}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge
            data-testid="agent-s-health-badge"
            variant={health ? HEALTH_BADGE_VARIANT[health.status] : 'secondary'}
          >
            {health ? STATUS_COPY[health.status] : 'Status unavailable'}
          </Badge>
          <Badge variant="outline">
            Mode: {health?.engine.mode ?? EngineMode.UITARS}
          </Badge>
          <Badge variant="outline">Runtime: {runtimeRuntimeLabel}</Badge>
          {runtimeStatus && (
            <Badge variant="outline">Controls: {runtimeStatus.status}</Badge>
          )}
        </div>

        {fallbackNotice && (
          <Alert
            data-testid="agent-s-fallback-status"
            className="border-amber-200 bg-amber-50"
          >
            <AlertTitle className="text-amber-800">
              Fallback in effect
            </AlertTitle>
            <AlertDescription
              className="text-amber-800"
              data-testid="engine-fallback-status"
            >
              {fallbackNotice}
            </AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
