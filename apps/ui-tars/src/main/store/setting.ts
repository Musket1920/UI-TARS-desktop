/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import ElectronStore from 'electron-store';
import yaml from 'js-yaml';

import * as env from '@main/env';
import { logger } from '@main/logger';
import { sanitizeAgentSPayload } from '@main/services/agentS/telemetry';

import {
  LocalStore,
  SearchEngineForSettings,
  VLMProviderV2,
  Operator,
  EngineMode,
  AgentSSidecarMode,
} from './types';
import { validatePreset } from './validate';
import { BrowserWindow } from 'electron';
import { enforceAgentSSafetyPolicy } from './safetyPolicy';

export const DEFAULT_SETTING: LocalStore = {
  language: 'en',
  vlmProvider: (env.vlmProvider as VLMProviderV2) || '',
  vlmBaseUrl: env.vlmBaseUrl || '',
  vlmApiKey: env.vlmApiKey || '',
  vlmModelName: env.vlmModelName || '',
  useResponsesApi: false,
  maxLoopCount: 100,
  loopIntervalInMs: 1000,
  searchEngineForBrowser: SearchEngineForSettings.GOOGLE,
  operator: Operator.LocalComputer,
  engineMode: EngineMode.UITARS,
  agentSSidecarMode: AgentSSidecarMode.Embedded,
  agentSEnableLocalEnv: false,
  reportStorageBaseUrl: '',
  utioBaseUrl: '',
};

export class SettingStore {
  private static instance: ElectronStore<LocalStore>;

  public static getInstance(): ElectronStore<LocalStore> {
    if (!SettingStore.instance) {
      SettingStore.instance = new ElectronStore<LocalStore>({
        name: 'ui_tars.setting',
        defaults: DEFAULT_SETTING,
      });

      SettingStore.instance.onDidAnyChange((newValue, oldValue) => {
        const safeValue = enforceAgentSSafetyPolicy(newValue as LocalStore);
        const didMutateUnsafeSetting =
          safeValue.agentSEnableLocalEnv !==
            (newValue as LocalStore).agentSEnableLocalEnv ||
          safeValue.maxLoopCount !== (newValue as LocalStore).maxLoopCount ||
          safeValue.loopIntervalInMs !==
            (newValue as LocalStore).loopIntervalInMs ||
          safeValue.agentSTurnTimeoutMs !==
            (newValue as LocalStore).agentSTurnTimeoutMs;

        if (didMutateUnsafeSetting) {
          SettingStore.instance.set(safeValue);
          return;
        }

        const previousState = (oldValue ?? ({} as LocalStore)) as LocalStore;
        const changedKeys = (
          Object.keys(safeValue) as Array<keyof LocalStore>
        ).filter((key) => {
          return !Object.is(previousState[key], safeValue[key]);
        });

        if (changedKeys.length > 0) {
          const formatValueForLog = (value: unknown): string => {
            if (value === undefined) {
              return 'undefined';
            }
            try {
              const stringified = JSON.stringify(value);
              return stringified === undefined ? 'undefined' : stringified;
            } catch (error) {
              logger.warn(
                'SettingStore: failed to stringify value for logging',
                error,
              );
              return '"[UNSERIALIZABLE]"';
            }
          };

          const summary = changedKeys
            .map((key) => {
              const maskedPrevious = sanitizeAgentSPayload({
                [key]: previousState[key],
              })[key];
              const maskedCurrent = sanitizeAgentSPayload({
                [key]: safeValue[key],
              })[key];
              return `${key}: ${formatValueForLog(maskedPrevious)} -> ${formatValueForLog(maskedCurrent)}`;
            })
            .join('; ');

          logger.log(
            `SettingStore updated (${changedKeys.length} keys): ${summary}`,
          );
        }
        // Notify that value updated
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('setting-updated', safeValue);
        });
      });
    }
    return SettingStore.instance;
  }

  public static set<K extends keyof LocalStore>(
    key: K,
    value: LocalStore[K],
  ): void {
    const current = SettingStore.getStore();
    const safeState = enforceAgentSSafetyPolicy({
      ...current,
      [key]: value,
    } as LocalStore);

    SettingStore.getInstance().set(key, safeState[key]);
  }

  public static setStore(state: LocalStore): void {
    SettingStore.getInstance().set(enforceAgentSSafetyPolicy(state));
  }

  public static get<K extends keyof LocalStore>(key: K): LocalStore[K] {
    return SettingStore.getInstance().get(key);
  }

  public static remove<K extends keyof LocalStore>(key: K): void {
    SettingStore.getInstance().delete(key);
  }

  public static getStore(): LocalStore {
    return enforceAgentSSafetyPolicy(SettingStore.getInstance().store);
  }

  public static clear(): void {
    SettingStore.getInstance().set(enforceAgentSSafetyPolicy(DEFAULT_SETTING));
  }

  public static openInEditor(): void {
    SettingStore.getInstance().openInEditor();
  }

  public static async importPresetFromUrl(
    url: string,
    autoUpdate = false,
  ): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch preset: ${response.status}`);
      }

      const yamlText = await response.text();
      const preset = yaml.load(yamlText);
      const validatedPreset = validatePreset(preset);

      SettingStore.setStore({
        ...enforceAgentSSafetyPolicy(validatedPreset),
        presetSource: {
          type: 'remote',
          url,
          autoUpdate,
          lastUpdated: Date.now(),
        },
      });
    } catch (error) {
      logger.error(error);
      throw new Error(
        `Failed to import preset: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  public static async importPresetFromText(
    yamlContent: string,
  ): Promise<LocalStore> {
    try {
      const settings = await parsePresetYaml(yamlContent);
      return settings;
    } catch (error) {
      logger.error('Failed to import preset from text:', error);
      throw error;
    }
  }

  public static async fetchPresetFromUrl(url: string): Promise<LocalStore> {
    try {
      const response = await fetch(url);
      const yamlContent = await response.text();
      return await this.importPresetFromText(yamlContent);
    } catch (error) {
      logger.error('Failed to fetch preset from URL:', error);
      throw error;
    }
  }
}

async function parsePresetYaml(yamlContent: string): Promise<LocalStore> {
  const preset = yaml.load(yamlContent);
  const validatedPreset = validatePreset(preset);
  return enforceAgentSSafetyPolicy(validatedPreset);
}
