/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Info,
  Loader2,
} from 'lucide-react';
import * as z from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import {
  VLMConnectionMode,
  VLMProviderV2,
} from '@main/store/types';
import { useSetting } from '@renderer/hooks/useSetting';
import { Button } from '@renderer/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
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
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@renderer/components/ui/alert';
import { cn } from '@renderer/utils';
import {
  areLocalConnectionSnapshotsEqual,
  getLocalConnectionFeedback,
  isValidHttpUrl,
  LOCALHOST_BASE_URL_HINT,
  LocalConnectionTestState,
  normalizeLocalConnectionSnapshot,
} from '@renderer/components/Settings/localhost';

import { PresetImport, PresetBanner } from './preset';
import { api } from '@renderer/api';

const formSchema = z.object({
  vlmConnectionMode: z.nativeEnum(VLMConnectionMode),
  vlmProvider: z.nativeEnum(VLMProviderV2, {
    message: 'Please select a VLM Provider to enhance resolution',
  }),
  vlmBaseUrl: z.string().trim().min(1, 'Enter the VLM base URL.'),
  vlmApiKey: z.string(),
  vlmModelName: z.string().trim().min(1, 'Enter the VLM model name.'),
}).superRefine((data, ctx) => {
  if (!isValidHttpUrl(data.vlmBaseUrl)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Enter a full http(s) URL, for example ${LOCALHOST_BASE_URL_HINT}.`,
      path: ['vlmBaseUrl'],
    });
  }

  if (
    data.vlmConnectionMode === VLMConnectionMode.Managed &&
    data.vlmApiKey.trim().length === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Enter the VLM API key.',
      path: ['vlmApiKey'],
    });
  }
});

type VLMSettingsFormValues = z.infer<typeof formSchema>;

const buildFormValuesFromSettings = (
  settings: ReturnType<typeof useSetting>['settings'],
): VLMSettingsFormValues => {
  return {
    vlmConnectionMode:
      settings.vlmConnectionMode ?? VLMConnectionMode.Managed,
    vlmProvider: settings.vlmProvider as VLMSettingsFormValues['vlmProvider'],
    vlmBaseUrl: settings.vlmBaseUrl ?? '',
    vlmApiKey: settings.vlmApiKey ?? '',
    vlmModelName: settings.vlmModelName ?? '',
  };
};

const normalizeFormValues = (
  values: VLMSettingsFormValues,
): VLMSettingsFormValues => {
  return {
    ...values,
    vlmBaseUrl: values.vlmBaseUrl.trim(),
    vlmApiKey: values.vlmApiKey.trim(),
    vlmModelName: values.vlmModelName.trim(),
  };
};

const areFormValuesEqual = (
  left: VLMSettingsFormValues,
  right: VLMSettingsFormValues,
): boolean => {
  return (
    left.vlmConnectionMode === right.vlmConnectionMode &&
    left.vlmProvider === right.vlmProvider &&
    left.vlmBaseUrl === right.vlmBaseUrl &&
    left.vlmApiKey === right.vlmApiKey &&
    left.vlmModelName === right.vlmModelName
  );
};

export interface VLMSettingsRef {
  submit: () => Promise<VLMSettingsFormValues>;
}

interface VLMSettingsProps {
  ref?: React.RefObject<VLMSettingsRef | null>;
  autoSave?: boolean;
  className?: string;
  onSubmitAvailabilityChange?: (canSubmit: boolean) => void;
}

export function VLMSettings({
  ref,
  autoSave = false,
  className,
  onSubmitAvailabilityChange,
}: VLMSettingsProps) {
  const { settings, updateSetting, updatePresetFromRemote } = useSetting();
  const [isPresetModalOpen, setPresetModalOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [localConnectionTest, setLocalConnectionTest] =
    useState<LocalConnectionTestState>({
      status: 'idle',
      snapshot: null,
      result: null,
    });

  const isRemoteAutoUpdatedPreset =
    settings?.presetSource?.type === 'remote' &&
    settings.presetSource.autoUpdate;
  const hasLoadedSettings = Object.keys(settings).length > 0;

  const settingsFormValues = useMemo(() => {
    return buildFormValuesFromSettings({
      vlmConnectionMode: settings.vlmConnectionMode,
      vlmProvider: settings.vlmProvider,
      vlmBaseUrl: settings.vlmBaseUrl,
      vlmApiKey: settings.vlmApiKey,
      vlmModelName: settings.vlmModelName,
    });
  }, [
    settings.vlmConnectionMode,
    settings.vlmProvider,
    settings.vlmBaseUrl,
    settings.vlmApiKey,
    settings.vlmModelName,
  ]);

  const persistedFormValues = useMemo(() => {
    return normalizeFormValues(settingsFormValues);
  }, [settingsFormValues]);

  const form = useForm<VLMSettingsFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: settingsFormValues,
  });

  useEffect(() => {
    if (hasLoadedSettings) {
      form.reset(settingsFormValues);
    }
  }, [form, hasLoadedSettings, settingsFormValues]);

  const [vlmConnectionMode, vlmProvider, vlmBaseUrl, vlmApiKey, vlmModelName] =
    form.watch([
      'vlmConnectionMode',
      'vlmProvider',
      'vlmBaseUrl',
      'vlmApiKey',
      'vlmModelName',
    ]);

  const currentFormValues = useMemo(() => {
    return normalizeFormValues({
      vlmConnectionMode,
      vlmProvider,
      vlmBaseUrl,
      vlmApiKey,
      vlmModelName,
    });
  }, [vlmApiKey, vlmBaseUrl, vlmConnectionMode, vlmModelName, vlmProvider]);

  const currentLocalConnectionSnapshot = useMemo(() => {
    return normalizeLocalConnectionSnapshot(currentFormValues);
  }, [currentFormValues]);

  const isLocalhostMode =
    currentFormValues.vlmConnectionMode ===
    VLMConnectionMode.LocalhostOpenAICompatible;
  const isCurrentLocalConnectionTest = areLocalConnectionSnapshotsEqual(
    localConnectionTest.snapshot,
    currentLocalConnectionSnapshot,
  );
  const hasCurrentSuccessfulLocalConnectionTest =
    isCurrentLocalConnectionTest && Boolean(localConnectionTest.result?.ok);
  const isLocalConnectionFeedbackStale =
    localConnectionTest.snapshot !== null && !isCurrentLocalConnectionTest;
  const canSubmitManagedMode = Boolean(
    currentFormValues.vlmProvider &&
      isValidHttpUrl(currentFormValues.vlmBaseUrl) &&
      currentFormValues.vlmApiKey.length > 0 &&
      currentFormValues.vlmModelName.length > 0,
  );
  const canSubmit = isLocalhostMode
    ? !isRemoteAutoUpdatedPreset &&
      hasCurrentSuccessfulLocalConnectionTest &&
      Boolean(currentFormValues.vlmProvider)
    : canSubmitManagedMode;

  useEffect(() => {
    onSubmitAvailabilityChange?.(canSubmit);
  }, [canSubmit, onSubmitAvailabilityChange]);

  useEffect(() => {
    if (!isLocalhostMode) {
      form.clearErrors(['vlmBaseUrl', 'vlmModelName']);
      return;
    }

    if (!isLocalConnectionFeedbackStale) {
      return;
    }

    form.clearErrors(['vlmBaseUrl', 'vlmModelName']);
  }, [form, isLocalConnectionFeedbackStale, isLocalhostMode]);

  useEffect(() => {
    if (!autoSave || isRemoteAutoUpdatedPreset || !hasLoadedSettings) {
      return;
    }

    if (isLocalhostMode) {
      return;
    }

    const persistManagedValues = async () => {
      const isValid = await form.trigger([
        'vlmConnectionMode',
        'vlmProvider',
        'vlmBaseUrl',
        'vlmApiKey',
        'vlmModelName',
      ]);

      if (!isValid || areFormValuesEqual(currentFormValues, persistedFormValues)) {
        return;
      }

      updateSetting({
        ...settings,
        ...currentFormValues,
        useResponsesApi: settings.useResponsesApi,
      });
    };

    void persistManagedValues();
  }, [
    autoSave,
    currentFormValues,
    form,
    hasLoadedSettings,
    isLocalhostMode,
    isRemoteAutoUpdatedPreset,
    persistedFormValues,
    settings,
    updateSetting,
  ]);

  const handlePresetModal = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    setPresetModalOpen(true);
  };

  const handleUpdatePreset = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      await updatePresetFromRemote();
    } catch (error) {
      toast.error('Failed to update preset', {
        description:
          error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  };

  const handleResetPreset = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    await window.electron.setting.resetPreset();
    toast.success('Reset to manual mode successfully', {
      duration: 1500,
    });
  };

  const handleTestConnection = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isRemoteAutoUpdatedPreset || !isLocalhostMode) {
      return;
    }

    form.clearErrors(['vlmBaseUrl', 'vlmModelName']);

    const snapshot = normalizeLocalConnectionSnapshot(form.getValues());
    let hasValidationError = false;

    if (snapshot.baseUrl.length === 0) {
      form.setError('vlmBaseUrl', {
        type: 'manual',
        message: 'Enter the localhost base URL.',
      });
      hasValidationError = true;
    } else if (!isValidHttpUrl(snapshot.baseUrl)) {
      form.setError('vlmBaseUrl', {
        type: 'manual',
        message: `Enter a full http(s) URL, for example ${LOCALHOST_BASE_URL_HINT}.`,
      });
      hasValidationError = true;
    }

    if (snapshot.modelName.length === 0) {
      form.setError('vlmModelName', {
        type: 'manual',
        message: 'Enter the localhost model name.',
      });
      hasValidationError = true;
    }

    if (hasValidationError) {
      setLocalConnectionTest({
        status: 'idle',
        snapshot: null,
        result: null,
      });
      return;
    }

    setLocalConnectionTest({
      status: 'testing',
      snapshot,
      result: null,
    });

    try {
      const result = await api.testLocalVLMConnection(snapshot);

      if (result.errorCode === 'INVALID_URL') {
        form.setError('vlmBaseUrl', {
          type: 'manual',
          message: `Enter a full http(s) URL, for example ${LOCALHOST_BASE_URL_HINT}.`,
        });
      }

      if (result.errorCode === 'UNREACHABLE') {
        form.setError('vlmBaseUrl', {
          type: 'manual',
          message:
            'Cannot reach this localhost endpoint. Verify the server is running and the URL is correct.',
        });
      }

      if (result.errorCode === 'MODEL_NOT_FOUND') {
        form.setError('vlmModelName', {
          type: 'manual',
          message:
            'This model was not found on the local server. Check the exact model name.',
        });
      }

      setLocalConnectionTest({
        status: 'completed',
        snapshot,
        result,
      });

      if (autoSave && result.ok) {
        const nextValues = normalizeFormValues(form.getValues());

        if (
          areLocalConnectionSnapshotsEqual(
            snapshot,
            normalizeLocalConnectionSnapshot(nextValues),
          ) &&
          Boolean(nextValues.vlmProvider)
        ) {
          try {
            await updateSetting({
              ...settings,
              ...nextValues,
              useResponsesApi: result.useResponsesApi,
            });
          } catch (error) {
            console.error('Failed to autosave localhost VLM settings', error);
          }
        }
      }
    } catch (error) {
      setLocalConnectionTest({
        status: 'completed',
        snapshot,
        result: {
          ok: false,
          modelAvailable: false,
          useResponsesApi: false,
          errorCode: 'UNKNOWN',
          errorMessage:
            error instanceof Error ? error.message : 'Unknown error occurred',
        },
      });
    }
  };

  useImperativeHandle(ref, () => ({
    submit: async () => {
      return new Promise<VLMSettingsFormValues>((resolve, reject) => {
        form.handleSubmit(
          async (values) => {
            try {
              const normalizedValues = normalizeFormValues(values);

              if (
                normalizedValues.vlmConnectionMode ===
                VLMConnectionMode.LocalhostOpenAICompatible
              ) {
                if (
                  !hasCurrentSuccessfulLocalConnectionTest ||
                  !isCurrentLocalConnectionTest ||
                  !localConnectionTest.result
                ) {
                  toast.error('Test the localhost connection before continuing.');
                  reject(new Error('Localhost connection test required'));
                  return;
                }

                await updateSetting({
                  ...settings,
                  ...normalizedValues,
                  useResponsesApi: localConnectionTest.result.useResponsesApi,
                });
                resolve(normalizedValues);
                return;
              }

              await updateSetting({
                ...settings,
                ...normalizedValues,
                useResponsesApi: settings.useResponsesApi,
              });
              resolve(normalizedValues);
            } catch (error) {
              reject(error);
            }
          },
          (errors) => {
            reject(errors);
          },
        )();
      });
    },
  }));

  return (
    <>
      <Form {...form}>
        <form className={cn('space-y-8 px-[1px]', className)}>
          {!isRemoteAutoUpdatedPreset && (
            <Button type="button" variant="outline" onClick={handlePresetModal}>
              Import Preset Config
            </Button>
          )}
          {isRemoteAutoUpdatedPreset && (
            <PresetBanner
              url={settings.presetSource?.url}
              date={settings.presetSource?.lastUpdated}
              handleUpdatePreset={handleUpdatePreset}
              handleResetPreset={handleResetPreset}
            />
          )}

          <FormField
            control={form.control}
            name="vlmConnectionMode"
            render={({ field }) => {
              return (
                <FormItem>
                  <FormLabel>Connection Mode</FormLabel>
                  <Select
                    disabled={isRemoteAutoUpdatedPreset}
                    onValueChange={field.onChange}
                    value={field.value}
                  >
                    <SelectTrigger
                      className="w-full bg-white"
                      data-testid="connection-mode"
                    >
                      <SelectValue placeholder="Select connection mode" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={VLMConnectionMode.Managed}>
                        Managed
                      </SelectItem>
                      <SelectItem
                        value={VLMConnectionMode.LocalhostOpenAICompatible}
                      >
                        Localhost (OpenAI-compatible)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {isRemoteAutoUpdatedPreset
                      ? 'Localhost mode is unavailable while an auto-updated preset is active. Reset to Manual in Remote Preset Management first.'
                      : 'Choose how UI-TARS connects to your VLM. Provider selection stays separate from localhost transport settings.'}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              );
            }}
          />

          <FormField
            control={form.control}
            name="vlmProvider"
            render={({ field }) => {
              return (
                <FormItem>
                  <FormLabel>VLM Provider</FormLabel>
                  <Select
                    disabled={isRemoteAutoUpdatedPreset}
                    onValueChange={field.onChange}
                    value={field.value}
                  >
                    <SelectTrigger
                      className="w-full bg-white"
                      data-testid="vlm-provider"
                    >
                      <SelectValue placeholder="Select VLM provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.values(VLMProviderV2).map((provider) => (
                        <SelectItem key={provider} value={provider}>
                          {provider}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              );
            }}
          />

          <FormField
            control={form.control}
            name="vlmBaseUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>VLM Base URL</FormLabel>
                <FormControl>
                  <Input
                    className="bg-white"
                    data-testid="vlm-base-url"
                    placeholder={
                      isLocalhostMode
                        ? LOCALHOST_BASE_URL_HINT
                        : 'Enter VLM Base URL'
                    }
                    {...field}
                    disabled={isRemoteAutoUpdatedPreset}
                  />
                </FormControl>
                <FormDescription>
                  {isLocalhostMode
                    ? 'Enter the full localhost endpoint, including protocol and path.'
                    : 'Managed connections require the full provider base URL.'}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="vlmApiKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>VLM API Key</FormLabel>
                <FormControl>
                  <div className="relative">
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      className="bg-white"
                      data-testid="vlm-api-key"
                      placeholder={
                        isLocalhostMode
                          ? 'Optional for localhost servers that do not require auth'
                          : 'Enter VLM API key'
                      }
                      {...field}
                      disabled={isRemoteAutoUpdatedPreset}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                      onClick={() => setShowPassword(!showPassword)}
                      disabled={isRemoteAutoUpdatedPreset}
                    >
                      {showPassword ? (
                        <Eye className="h-4 w-4 text-gray-500" />
                      ) : (
                        <EyeOff className="h-4 w-4 text-gray-500" />
                      )}
                    </Button>
                  </div>
                </FormControl>
                <FormDescription>
                  {isLocalhostMode
                    ? 'Leave blank if your localhost server does not require an API key.'
                    : 'Managed mode requires a valid API key.'}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="vlmModelName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>VLM Model Name</FormLabel>
                <FormControl>
                  <Input
                    className="bg-white"
                    data-testid="vlm-model-name"
                    placeholder={
                      isLocalhostMode
                        ? 'Enter the exact localhost model name'
                        : 'Enter VLM Model Name'
                    }
                    {...field}
                    disabled={isRemoteAutoUpdatedPreset}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {isLocalhostMode && (
            <div className="space-y-3 rounded-md border border-border bg-muted/30 p-4">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">
                  Localhost connection test
                </span>
                <p className="text-sm text-muted-foreground">
                  Test the current localhost settings before saving or starting.
                  The latest successful test must match these exact values.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                data-testid="test-connection"
                disabled={
                  isRemoteAutoUpdatedPreset ||
                  localConnectionTest.status === 'testing'
                }
                onClick={handleTestConnection}
              >
                {localConnectionTest.status === 'testing' ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Testing connection...
                  </>
                ) : (
                  'Test connection'
                )}
              </Button>

              {localConnectionTest.status === 'completed' &&
                isCurrentLocalConnectionTest &&
                localConnectionTest.result && (() => {
                  const feedback = getLocalConnectionFeedback(
                    localConnectionTest.result,
                  );

                  return (
                    <Alert
                      className={
                        feedback.tone === 'success'
                          ? 'border-green-200 bg-green-50'
                          : feedback.tone === 'warning'
                            ? 'border-amber-200 bg-amber-50'
                            : 'border-destructive/30 bg-destructive/5'
                      }
                    >
                      {feedback.tone === 'success' ? (
                        <CheckCircle2 className="!text-green-600" />
                      ) : feedback.tone === 'warning' ? (
                        <Info className="!text-amber-600" />
                      ) : (
                        <AlertCircle className="!text-destructive" />
                      )}
                      <AlertTitle
                        className={
                          feedback.tone === 'success'
                            ? 'text-green-900'
                            : feedback.tone === 'warning'
                              ? 'text-amber-900'
                              : 'text-destructive'
                        }
                      >
                        {feedback.title}
                      </AlertTitle>
                      <AlertDescription
                        className={
                          feedback.tone === 'success'
                            ? 'text-green-800'
                            : feedback.tone === 'warning'
                              ? 'text-amber-800'
                              : undefined
                        }
                      >
                        {feedback.description}
                        {localConnectionTest.result.ok && (
                          <p>
                            Detected capability:{' '}
                            {localConnectionTest.result.useResponsesApi
                              ? 'Responses API supported'
                              : 'Chat Completions only (Responses API unavailable)'}
                            .
                          </p>
                        )}
                        {!localConnectionTest.result.ok &&
                          localConnectionTest.result.errorMessage &&
                          localConnectionTest.result.errorCode !== 'INVALID_URL' && (
                            <p>
                              Details: {localConnectionTest.result.errorMessage}
                            </p>
                          )}
                      </AlertDescription>
                    </Alert>
                  );
                })()}

              {isLocalConnectionFeedbackStale && (
                <p className="text-sm text-muted-foreground">
                  Localhost details changed. Test the connection again to apply
                  these settings.
                </p>
              )}
            </div>
          )}
        </form>
      </Form>

      <PresetImport
        isOpen={isPresetModalOpen}
        onClose={() => setPresetModalOpen(false)}
      />
    </>
  );
}
