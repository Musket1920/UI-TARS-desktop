/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
// /apps/ui-tars/src/renderer/src/pages/settings/index.tsx
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Loader2,
  RefreshCcw,
  Trash,
} from 'lucide-react';
import { useRef, useEffect, useMemo, useState } from 'react';
import * as z from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { api } from '@renderer/api';
import {
  SearchEngineForSettings,
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
import { ScrollArea } from '@renderer/components/ui/scroll-area';
import { Input } from '@renderer/components/ui/input';
import { DragArea } from '@renderer/components/Common/drag';
import { BROWSER_OPERATOR } from '@renderer/const';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@renderer/components/ui/alert';
import {
  areLocalConnectionSnapshotsEqual,
  getLocalConnectionFeedback,
  isValidHttpUrl,
  LOCALHOST_BASE_URL_HINT,
  LocalConnectionTestState,
  normalizeLocalConnectionSnapshot,
} from '@renderer/components/Settings/localhost';

import { PresetImport } from './PresetImport';
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { PresetBanner } from './PresetBanner';

import googleIcon from '@resources/icons/google-color.svg?url';
import bingIcon from '@resources/icons/bing-color.svg?url';
import baiduIcon from '@resources/icons/baidu-color.svg?url';
import { REPO_OWNER, REPO_NAME } from '@main/shared/constants';

const formSchema = z.object({
  language: z.enum(['en', 'zh']),
  vlmConnectionMode: z.nativeEnum(VLMConnectionMode),
  vlmProvider: z.nativeEnum(VLMProviderV2, {
    message: 'Please select a VLM Provider to enhance resolution',
  }),
  vlmBaseUrl: z.string().trim().min(1, 'Enter the VLM base URL.'),
  vlmApiKey: z.string(),
  vlmModelName: z.string().trim().min(1, 'Enter the VLM model name.'),
  maxLoopCount: z.number().min(25).max(200),
  loopIntervalInMs: z.number().min(0).max(3000),
  searchEngineForBrowser: z.nativeEnum(SearchEngineForSettings),
  reportStorageBaseUrl: z.string().optional(),
  utioBaseUrl: z.string().optional(),
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

type SettingsFormValues = z.infer<typeof formSchema>;

const buildFormValuesFromSettings = (
  settings: ReturnType<typeof useSetting>['settings'],
): SettingsFormValues => {
  return {
    language: settings.language ?? 'en',
    vlmConnectionMode:
      settings.vlmConnectionMode ?? VLMConnectionMode.Managed,
    vlmProvider: settings.vlmProvider as SettingsFormValues['vlmProvider'],
    vlmBaseUrl: settings.vlmBaseUrl ?? '',
    vlmApiKey: settings.vlmApiKey ?? '',
    vlmModelName: settings.vlmModelName ?? '',
    maxLoopCount: settings.maxLoopCount ?? 100,
    loopIntervalInMs: settings.loopIntervalInMs ?? 1000,
    searchEngineForBrowser:
      settings.searchEngineForBrowser ?? SearchEngineForSettings.GOOGLE,
    reportStorageBaseUrl: settings.reportStorageBaseUrl ?? '',
    utioBaseUrl: settings.utioBaseUrl ?? '',
  };
};

const SECTIONS = {
  vlm: 'VLM Settings',
  chat: 'Chat Settings',
  report: 'Report Settings',
  general: 'General',
} as const;

export default function Settings() {
  const { settings, updateSetting, clearSetting, updatePresetFromRemote } =
    useSetting();
  const [isPresetModalOpen, setPresetModalOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('vlm');
  const [localConnectionTest, setLocalConnectionTest] =
    useState<LocalConnectionTestState>({
      status: 'idle',
      snapshot: null,
      result: null,
    });
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateDetail, setUpdateDetail] = useState<{
    currentVersion: string;
    version: string;
    link: string | null;
  } | null>();

  const handleCheckForUpdates = async () => {
    setUpdateLoading(true);
    try {
      const detail = await api.checkForUpdatesDetail();

      if (detail.updateInfo) {
        setUpdateDetail({
          currentVersion: detail.currentVersion,
          version: detail.updateInfo.version,
          link: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/v${detail.updateInfo.version}`,
        });
        return;
      } else if (!detail.isPackaged) {
        toast.info('Unpackaged version does not support update check!');
      } else {
        toast.success('No update available', {
          description: `current version: ${detail.currentVersion} is the latest version`,
          position: 'top-right',
          richColors: true,
        });
      }
    } catch (error) {
      console.error('Failed to check for updates:', error);
    } finally {
      setUpdateLoading(false);
    }
  };

  const isRemoteAutoUpdatedPreset =
    settings?.presetSource?.type === 'remote' &&
    settings.presetSource.autoUpdate;

  const hasLoadedSettings = Object.keys(settings).length > 0;
  const settingsFormValues = useMemo(() => {
    return buildFormValuesFromSettings({
      language: settings.language,
      vlmConnectionMode: settings.vlmConnectionMode,
      vlmProvider: settings.vlmProvider,
      vlmBaseUrl: settings.vlmBaseUrl,
      vlmApiKey: settings.vlmApiKey,
      vlmModelName: settings.vlmModelName,
      maxLoopCount: settings.maxLoopCount,
      loopIntervalInMs: settings.loopIntervalInMs,
      searchEngineForBrowser: settings.searchEngineForBrowser,
      reportStorageBaseUrl: settings.reportStorageBaseUrl,
      utioBaseUrl: settings.utioBaseUrl,
    });
  }, [
    settings.language,
    settings.vlmConnectionMode,
    settings.vlmProvider,
    settings.vlmBaseUrl,
    settings.vlmApiKey,
    settings.vlmModelName,
    settings.maxLoopCount,
    settings.loopIntervalInMs,
    settings.searchEngineForBrowser,
    settings.reportStorageBaseUrl,
    settings.utioBaseUrl,
  ]);

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: settingsFormValues,
  });

  useEffect(() => {
    if (hasLoadedSettings) {
      form.reset(settingsFormValues);
    }
  }, [form, hasLoadedSettings, settingsFormValues]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        });
      },
      { threshold: 0.5 },
    );

    Object.values(sectionRefs.current).forEach((ref) => {
      if (ref) observer.observe(ref);
    });

    return () => observer.disconnect();
  }, []);

  const scrollToSection = (section: string) => {
    sectionRefs.current[section]?.scrollIntoView({ behavior: 'smooth' });
  };

  const [vlmConnectionMode, vlmBaseUrl, vlmApiKey, vlmModelName] = form.watch([
    'vlmConnectionMode',
    'vlmBaseUrl',
    'vlmApiKey',
    'vlmModelName',
  ]);

  const currentLocalConnectionSnapshot = useMemo(() => {
    return normalizeLocalConnectionSnapshot({
      vlmBaseUrl,
      vlmApiKey,
      vlmModelName,
    });
  }, [vlmApiKey, vlmBaseUrl, vlmModelName]);

  const isLocalhostMode =
    vlmConnectionMode === VLMConnectionMode.LocalhostOpenAICompatible;
  const isCurrentLocalConnectionTest = areLocalConnectionSnapshotsEqual(
    localConnectionTest.snapshot,
    currentLocalConnectionSnapshot,
  );
  const hasCurrentSuccessfulLocalConnectionTest =
    isCurrentLocalConnectionTest && Boolean(localConnectionTest.result?.ok);
  const isLocalConnectionFeedbackStale =
    localConnectionTest.snapshot !== null && !isCurrentLocalConnectionTest;
  const canSaveLocalhostMode =
    hasCurrentSuccessfulLocalConnectionTest &&
    localConnectionTest.status !== 'testing';
  const saveDisabled =
    form.formState.isSubmitting ||
    (isLocalhostMode && !canSaveLocalhostMode) ||
    localConnectionTest.status === 'testing';

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

  const onSubmit = async (values: SettingsFormValues) => {
    if (isLocalhostMode && !canSaveLocalhostMode) {
      toast.error('Test the localhost connection before saving.');
      return;
    }

    updateSetting({
      ...settings,
      ...values,
      vlmBaseUrl: values.vlmBaseUrl.trim(),
      vlmApiKey: values.vlmApiKey.trim(),
      vlmModelName: values.vlmModelName.trim(),
      useResponsesApi:
        isLocalhostMode && localConnectionTest.result
          ? localConnectionTest.result.useResponsesApi
          : settings.useResponsesApi,
    });
    // toast.success('Settings saved successfully');
    // await api.closeSettingsWindow();
    await api.showMainWindow();
  };

  const onCancel = async () => {
    // await api.closeSettingsWindow();
  };

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
      toast.success('Preset updated successfully');
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

  const handleClearSettings = async () => {
    try {
      await clearSetting();
      toast.success('All settings cleared successfully');
    } catch (error) {
      toast.error('Failed to clear settings', {
        description:
          error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  };

  return (
    <div className="h-screen flex flex-col bg-white">
      <DragArea />

      <div className="flex-1 flex gap-4 p-6 overflow-hidden">
        <Tabs
          orientation="vertical"
          value={activeSection}
          onValueChange={scrollToSection}
          className="w-34 shrink-0"
        >
          <TabsList className="flex flex-col h-auto bg-transparent p-0">
            {Object.entries(SECTIONS).map(([key, label]) => (
              <TabsTrigger
                key={key}
                value={key}
                className="justify-start w-full rounded-none border-0 border-l-4 data-[state=active]:shadow-none data-[state=active]:border-primary mb-1"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <ScrollArea className="flex-1">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
              <div
                id="vlm"
                ref={(el) => {
                  sectionRefs.current.vlm = el;
                }}
                className="space-y-6 ml-1 mr-4"
              >
                <h2 className="text-lg font-medium">{SECTIONS.vlm}</h2>
                {!isRemoteAutoUpdatedPreset && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handlePresetModal}
                  >
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
                {/* Model Settings Fields */}
                <FormField
                  control={form.control}
                  name="language"
                  render={({ field }) => {
                    return (
                      <FormItem>
                        <FormLabel>Language</FormLabel>
                        <Select
                          disabled={isRemoteAutoUpdatedPreset}
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select language" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="en">English</SelectItem>
                            <SelectItem value="zh">中文</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormItem>
                    );
                  }}
                />
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
                          <SelectTrigger data-testid="connection-mode">
                            <SelectValue placeholder="Select connection mode" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={VLMConnectionMode.Managed}>
                              Managed
                            </SelectItem>
                            <SelectItem
                              value={
                                VLMConnectionMode.LocalhostOpenAICompatible
                              }
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
                {/* VLM Provider */}
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
                          <SelectTrigger>
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
                {/* VLM Base URL */}
                <FormField
                  control={form.control}
                  name="vlmBaseUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>VLM Base URL</FormLabel>
                      <FormControl>
                        <Input
                          disabled={isRemoteAutoUpdatedPreset}
                          data-testid="vlm-base-url"
                          placeholder={
                            isLocalhostMode
                              ? LOCALHOST_BASE_URL_HINT
                              : 'Enter VLM Base URL'
                          }
                          {...field}
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
                {/* VLM API Key */}
                <FormField
                  control={form.control}
                  name="vlmApiKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>VLM API Key</FormLabel>
                      <FormControl>
                        <Input
                          disabled={isRemoteAutoUpdatedPreset}
                          data-testid="vlm-api-key"
                          placeholder={
                            isLocalhostMode
                              ? 'Optional for localhost servers that do not require auth'
                              : 'Enter VLM API key'
                          }
                          {...field}
                        />
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
                {/* VLM Model Name */}
                <FormField
                  control={form.control}
                  name="vlmModelName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>VLM Model Name</FormLabel>
                      <FormControl>
                        <Input
                          disabled={isRemoteAutoUpdatedPreset}
                          data-testid="vlm-model-name"
                          placeholder={
                            isLocalhostMode
                              ? 'Enter the exact localhost model name'
                              : 'Enter VLM Model Name'
                          }
                          {...field}
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
                        Test the current localhost settings before saving. Save
                        stays disabled until the latest test passes for these
                        exact values.
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
                                localConnectionTest.result.errorCode !==
                                  'INVALID_URL' && (
                                  <p>
                                    Details:{' '}
                                    {localConnectionTest.result.errorMessage}
                                  </p>
                                )}
                            </AlertDescription>
                          </Alert>
                        );
                      })()}

                    {isLocalConnectionFeedbackStale && (
                      <p className="text-sm text-muted-foreground">
                        Localhost details changed. Test the connection again to
                        re-enable Save.
                      </p>
                    )}
                  </div>
                )}
              </div>
              {/* Chat Settings */}
              <div
                id="chat"
                ref={(el) => {
                  sectionRefs.current.chat = el;
                }}
                className="space-y-6 pt-6 ml-1 mr-4"
              >
                <h2 className="text-lg font-medium">{SECTIONS.chat}</h2>
                <FormField
                  control={form.control}
                  name="maxLoopCount"
                  render={({ field }) => {
                    return (
                      <FormItem>
                        <FormLabel>Max Loop</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            // disabled={isRemoteAutoUpdatedPreset}
                            placeholder="Enter a number between 25-200"
                            {...field}
                            value={field.value === 0 ? '' : field.value}
                            onChange={(e) =>
                              field.onChange(Number(e.target.value))
                            }
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    );
                  }}
                />
                <FormField
                  control={form.control}
                  name="loopIntervalInMs"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Loop Wait Time (ms)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          // disabled={isRemoteAutoUpdatedPreset}
                          placeholder="Enter a number between 0-3000"
                          {...field}
                          value={field.value === 0 ? '' : field.value}
                          onChange={(e) =>
                            field.onChange(Number(e.target.value))
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="searchEngineForBrowser"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Search engine for {BROWSER_OPERATOR}:
                      </FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                      >
                        <FormControl>
                          <SelectTrigger className="w-[124px]">
                            <SelectValue placeholder="Select a search engine" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={SearchEngineForSettings.GOOGLE}>
                            <div className="flex items-center gap-2">
                              <img
                                src={googleIcon}
                                alt="Google"
                                className="w-4 h-4"
                              />
                              <span>Google</span>
                            </div>
                          </SelectItem>
                          <SelectItem value={SearchEngineForSettings.BING}>
                            <div className="flex items-center gap-2">
                              <img
                                src={bingIcon}
                                alt="Bing"
                                className="w-4 h-4"
                              />
                              <span>Bing</span>
                            </div>
                          </SelectItem>
                          <SelectItem value={SearchEngineForSettings.BAIDU}>
                            <div className="flex items-center gap-2">
                              <img
                                src={baiduIcon}
                                alt="Baidu"
                                className="w-4 h-4"
                              />
                              <span>Baidu</span>
                            </div>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div
                id="report"
                ref={(el) => {
                  sectionRefs.current.report = el;
                }}
                className="space-y-6 pt-6 ml-1 mr-4"
              >
                <h2 className="text-lg font-medium">{SECTIONS.report}</h2>
                {/* Report Settings Fields */}
                <FormField
                  control={form.control}
                  name="reportStorageBaseUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Report Storage Base URL</FormLabel>
                      <FormControl>
                        <Input
                          disabled={isRemoteAutoUpdatedPreset}
                          placeholder="https://your-report-storage-endpoint.com/upload"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {/* UTIO Base URL */}
                <FormField
                  control={form.control}
                  name="utioBaseUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>UTIO Base URL</FormLabel>
                      <FormControl>
                        <Input
                          disabled={isRemoteAutoUpdatedPreset}
                          placeholder="https://your-utio-endpoint.com/collect"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="h-50"></div>
              </div>

              <div
                id="general"
                ref={(el) => {
                  sectionRefs.current.general = el;
                }}
                className="space-y-6 ml-1 mr-4"
              >
                <h2 className="text-lg font-medium">{SECTIONS.general}</h2>
                <Button
                  variant="outline"
                  type="button"
                  disabled={updateLoading}
                  onClick={handleCheckForUpdates}
                >
                  <RefreshCcw
                    className={`h-4 w-4 mr-2 ${updateLoading ? 'animate-spin' : ''}`}
                  />
                  {updateLoading ? 'Checking...' : 'Check Updates'}
                </Button>
                {updateDetail?.version && (
                  <div className="text-sm text-gray-500">
                    {`${updateDetail.currentVersion} -> ${updateDetail.version}(latest)`}
                  </div>
                )}
                {updateDetail?.link && (
                  <div className="text-sm text-gray-500">
                    Release Notes:{' '}
                    <a
                      href={updateDetail.link}
                      target="_blank"
                      className="underline"
                      rel="noreferrer"
                    >
                      {updateDetail.link}
                    </a>
                  </div>
                )}
                <div className="h-50" />
              </div>
            </form>
          </Form>
        </ScrollArea>
      </div>

      <div className="border-t p-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex justify-between items-center">
          <Button
            variant="outline"
            type="button"
            className="text-red-400 border-red-400 hover:bg-red-50 hover:text-red-500"
            onClick={handleClearSettings}
          >
            <Trash className="h-4 w-4" />
            Clear
          </Button>
          <div className="flex gap-4">
            <Button variant="outline" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saveDisabled}
              onClick={form.handleSubmit(onSubmit)}
            >
              Save
            </Button>
          </div>
        </div>
      </div>

      <PresetImport
        isOpen={isPresetModalOpen}
        onClose={() => setPresetModalOpen(false)}
      />
    </div>
  );
}

export { Settings as Component };
