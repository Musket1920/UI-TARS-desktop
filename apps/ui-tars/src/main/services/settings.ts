/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { ipcMain } from 'electron';
import { SettingStore } from '../store/setting';
import { logger } from '../logger';
import { LocalStore } from '@main/store/validate';
import { enforceAgentSSafetyPolicy } from '@main/store/safetyPolicy';

const enforceAgentSSafetyDefaults = (settings: LocalStore): LocalStore => {
  return enforceAgentSSafetyPolicy(settings);
};

const agentSSidecarRelevantSettingsKeys = [
  'engineMode',
  'agentSSidecarMode',
  'agentSSidecarUrl',
  'agentSSidecarPort',
] as const satisfies readonly (keyof LocalStore)[];

const haveAgentSSidecarRelevantSettingsChanged = (
  previousSettings: LocalStore,
  nextSettings: LocalStore,
): boolean => {
  return agentSSidecarRelevantSettingsKeys.some(
    (key) => previousSettings[key] !== nextSettings[key],
  );
};

export function registerSettingsHandlers(
  onSettingsUpdated?: (settings: LocalStore) => Promise<void> | void,
) {
  const notifySettingsUpdated = async (settings: LocalStore) => {
    if (!onSettingsUpdated) {
      return;
    }

    try {
      await onSettingsUpdated(settings);
    } catch (error) {
      logger.error('Failed to handle settings update callback:', error);
    }
  };

  /**
   * Get setting
   */
  ipcMain.handle('setting:get', () => {
    return SettingStore.getStore();
  });

  /**
   * Clear setting
   */
  ipcMain.handle('setting:clear', () => {
    SettingStore.clear();
  });

  /**
   * Reset setting preset
   */
  ipcMain.handle('setting:resetPreset', () => {
    SettingStore.getInstance().delete('presetSource');
  });

  /**
   * Update setting
   */
  ipcMain.handle('setting:update', async (_, settings: LocalStore) => {
    const previousSettings = SettingStore.getStore();
    const nextSettings = enforceAgentSSafetyDefaults(settings);

    SettingStore.setStore(nextSettings);

    if (
      haveAgentSSidecarRelevantSettingsChanged(previousSettings, nextSettings)
    ) {
      void notifySettingsUpdated(nextSettings);
    }
  });

  /**
   * Import setting preset from text
   */
  ipcMain.handle('setting:importPresetFromText', async (_, yamlContent) => {
    try {
      const previousSettings = SettingStore.getStore();
      const newSettings = await SettingStore.importPresetFromText(yamlContent);
      const nextSettings = enforceAgentSSafetyDefaults(newSettings);

      SettingStore.setStore(nextSettings);

      if (
        haveAgentSSidecarRelevantSettingsChanged(previousSettings, nextSettings)
      ) {
        void notifySettingsUpdated(nextSettings);
      }
    } catch (error) {
      logger.error('Failed to import preset:', error);
      throw error;
    }
  });

  /**
   * Import setting preset from url
   */
  ipcMain.handle('setting:importPresetFromUrl', async (_, url, autoUpdate) => {
    try {
      const previousSettings = SettingStore.getStore();
      const newSettings = await SettingStore.fetchPresetFromUrl(url);
      const nextSettings: LocalStore = {
        ...enforceAgentSSafetyDefaults(newSettings),
        presetSource: {
          type: 'remote',
          url: url,
          autoUpdate: autoUpdate,
          lastUpdated: Date.now(),
        },
      };

      SettingStore.setStore(nextSettings);

      if (
        haveAgentSSidecarRelevantSettingsChanged(previousSettings, nextSettings)
      ) {
        void notifySettingsUpdated(nextSettings);
      }
    } catch (error) {
      logger.error('Failed to import preset from URL:', error);
      throw error;
    }
  });

  /**
   * Update setting preset from url
   */
  ipcMain.handle('setting:updatePresetFromRemote', async () => {
    const previousSettings = SettingStore.getStore();
    if (
      previousSettings.presetSource?.type === 'remote' &&
      previousSettings.presetSource.url
    ) {
      const newSettings = await SettingStore.fetchPresetFromUrl(
        previousSettings.presetSource.url,
      );
      const nextSettings: LocalStore = {
        ...enforceAgentSSafetyDefaults(newSettings),
        presetSource: {
          type: 'remote',
          url: previousSettings.presetSource.url,
          autoUpdate: previousSettings.presetSource.autoUpdate,
          lastUpdated: Date.now(),
        },
      };

      SettingStore.setStore(nextSettings);

      if (
        haveAgentSSidecarRelevantSettingsChanged(previousSettings, nextSettings)
      ) {
        void notifySettingsUpdated(nextSettings);
      }
    } else {
      throw new Error('No remote preset configured');
    }
  });
}
