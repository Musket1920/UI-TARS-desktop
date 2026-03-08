/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { electronApp, optimizer } from '@electron-toolkit/utils';
import {
  app,
  BrowserView,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
  WebContentsView,
  screen,
} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import ElectronStore from 'electron-store';

import * as env from '@main/env';
import { logger } from '@main/logger';
import {
  agentSSidecarManager,
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_STARTUP_POLL_INTERVAL_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
} from '@main/services/agentS/sidecarManager';
import { createMainWindow } from '@main/window/index';
import { registerIpcMain } from '@ui-tars/electron-ipc/main';
import { ipcRoutes } from './ipcRoutes';

import { UTIOService } from './services/utio';
import { store } from './store/create';
import { SettingStore } from './store/setting';
import { AgentSSidecarMode, EngineMode } from './store/types';
import { createTray } from './tray';
import { registerSettingsHandlers } from './services/settings';
import { sanitizeState } from './utils/sanitizeState';
import { windowManager } from './services/windowManager';
import { checkBrowserAvailability } from './services/browserCheck';
import { resolveSidecarEndpoint } from './utils/resolveSidecarEndpoint';

const { isProd } = env;

let hasHandledBeforeQuit = false;

const parseSidecarArgs = (rawArgs: string | undefined): string[] => {
  if (!rawArgs) {
    return [];
  }

  const args: string[] = [];
  let currentArg = '';
  let activeQuote: '"' | "'" | null = null;

  const pushCurrentArg = () => {
    if (currentArg) {
      args.push(currentArg);
    }

    currentArg = '';
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const char = rawArgs[index];

    if (activeQuote) {
      const nextChar = rawArgs[index + 1];

      if (char === '\\' && (nextChar === activeQuote || nextChar === '\\')) {
        currentArg += nextChar;
        index += 1;
        continue;
      }

      if (char === activeQuote) {
        activeQuote = null;
        continue;
      }

      currentArg += char;
      continue;
    }

    if (char === '"' || char === "'") {
      activeQuote = char;
      continue;
    }

    if (char === ' ') {
      pushCurrentArg();
      continue;
    }

    currentArg += char;
  }

  pushCurrentArg();

  return args;
};

const startAgentSSidecarIfNeeded = async (
  settings = SettingStore.getStore(),
) => {
  if (settings.engineMode !== EngineMode.AgentS) {
    const status = await agentSSidecarManager.stop();
    logger.info(
      '[agentS sidecar] manager disabled because engine mode is not Agent-S',
      {
        state: status.state,
      },
    );
    return;
  }

  const endpoint = resolveSidecarEndpoint(
    settings.agentSSidecarUrl,
    settings.agentSSidecarPort,
  );
  const startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;
  const startupPollIntervalMs = DEFAULT_STARTUP_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  const healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS;
  const shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;

  if (settings.agentSSidecarMode === AgentSSidecarMode.Remote) {
    const status = await agentSSidecarManager.start({
      mode: 'external',
      endpoint,
      startupTimeoutMs,
      startupPollIntervalMs,
      heartbeatIntervalMs,
      healthTimeoutMs,
      shutdownTimeoutMs,
    });

    logger.info('[agentS sidecar] external endpoint status', {
      state: status.state,
      healthy: status.healthy,
      reason: status.reason,
      endpoint: status.endpoint,
    });
    return;
  }

  const command = process.env.AGENT_S_SIDECAR_COMMAND?.trim() || 'agent_s';
  const args = parseSidecarArgs(process.env.AGENT_S_SIDECAR_ARGS);

  const status = await agentSSidecarManager.start({
    mode: 'embedded',
    command,
    args,
    endpoint,
    env: process.env,
    startupTimeoutMs,
    startupPollIntervalMs,
    heartbeatIntervalMs,
    healthTimeoutMs,
    shutdownTimeoutMs,
  });

  logger.info('[agentS sidecar] embedded status', {
    state: status.state,
    healthy: status.healthy,
    reason: status.reason,
    endpoint: status.endpoint,
    pid: status.pid,
  });
};

const startAgentSSidecarInBackground = (
  startSidecar: () => Promise<void> = startAgentSSidecarIfNeeded,
  logError: typeof logger.error = logger.error,
) => {
  void startSidecar().catch((error) => {
    logError(
      '[agentS sidecar] failed to start during app initialization',
      error,
    );
  });
};

// 在应用初始化之前启用辅助功能支持
app.commandLine.appendSwitch('force-renderer-accessibility');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (squirrelStartup) {
  app.quit();
}

logger.debug('[env]', env);

ElectronStore.initRenderer();

if (isProd) {
  import('source-map-support').then(({ default: sourceMapSupport }) => {
    sourceMapSupport.install();
  });
}

const loadDevDebugTools = async () => {
  import('electron-debug').then(({ default: electronDebug }) => {
    electronDebug({ showDevTools: false });
  });

  import('electron-devtools-installer')
    .then(({ default: installExtensionDefault, REACT_DEVELOPER_TOOLS }) => {
      // @ts-ignore
      const installExtension = installExtensionDefault?.default;
      const extensions = [installExtension(REACT_DEVELOPER_TOOLS)];

      return Promise.all(extensions)
        .then((names) => logger.info('Added Extensions:', names.join(', ')))
        .catch((err) =>
          logger.error('An error occurred adding extension:', err),
        );
    })
    .catch(logger.error);
};

const initializeApp = async () => {
  const isAccessibilityEnabled = app.isAccessibilitySupportEnabled();
  logger.info('isAccessibilityEnabled', isAccessibilityEnabled);
  if (env.isMacOS) {
    app.setAccessibilitySupportEnabled(true);
    const { ensurePermissions } = await import('@main/utils/systemPermissions');

    const ensureScreenCapturePermission = ensurePermissions();
    logger.info('ensureScreenCapturePermission', ensureScreenCapturePermission);
  }

  await checkBrowserAvailability();

  // if (env.isDev) {
  await loadDevDebugTools();
  // }

  logger.info('createTray');
  // Tray
  await createTray();

  // Send app launched event
  await UTIOService.getInstance().appLaunched();

  logger.info('createMainWindow');
  let mainWindow = createMainWindow();

  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        const primaryDisplay = screen.getPrimaryDisplay();
        const primarySource = sources.find(
          (source) => source.display_id === primaryDisplay.id.toString(),
        );

        callback({ video: primarySource!, audio: 'loopback' });
      });
    },
    { useSystemPicker: false },
  );

  logger.info('mainZustandBridge');

  const { unsubscribe } = registerIPCHandlers([mainWindow]);

  app.on('window-all-closed', () => {
    logger.info('window-all-closed');
    if (!env.isMacOS) {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    if (hasHandledBeforeQuit) {
      logger.info('before-quit (finalize)');
      const windows = BrowserWindow.getAllWindows();
      windows.forEach((window) => {
        window.destroy();
      });
      return;
    }

    logger.info('before-quit');
    hasHandledBeforeQuit = true;

    event.preventDefault();

    void agentSSidecarManager
      .stop()
      .catch((error) => {
        logger.error('[agentS sidecar] failed to stop before quit', error);
      })
      .finally(() => {
        app.quit();
      });
  });

  app.on('quit', () => {
    logger.info('app quit');
    unsubscribe();
  });

  app.on('activate', () => {
    logger.info('app activate');
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow();
    } else {
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
    }
  });

  logger.info('initializeApp end');

  // Check and update remote presets
  const settings = SettingStore.getStore();
  if (
    settings.presetSource?.type === 'remote' &&
    settings.presetSource.autoUpdate
  ) {
    try {
      await SettingStore.importPresetFromUrl(settings.presetSource.url!, true);
    } catch (error) {
      logger.error('Failed to update preset:', error);
    }
  }

  startAgentSSidecarInBackground();
};

/**
 * Register IPC handlers
 */
const registerIPCHandlers = (
  wrappers: (BrowserWindow | WebContentsView | BrowserView)[],
) => {
  ipcMain.handle('getState', () => {
    const state = store.getState();
    return sanitizeState(state);
  });

  // 初始化时注册已有窗口
  wrappers.forEach((wrapper) => {
    if (wrapper instanceof BrowserWindow) {
      windowManager.registerWindow(wrapper);
    }
  });

  // only send state to the wrappers that are not destroyed
  ipcMain.on('subscribe', (state: unknown) => {
    const sanitizedState = sanitizeState(state as Record<string, unknown>);
    windowManager.broadcast('subscribe', sanitizedState);
  });

  const unsubscribe = store.subscribe((state: unknown) =>
    ipcMain.emit('subscribe', state),
  );

  // TODO: move to ipc routes
  ipcMain.handle('utio:shareReport', async (_, params) => {
    await UTIOService.getInstance().shareReport(params);
  });

  registerSettingsHandlers(async (settings) => {
    await startAgentSSidecarIfNeeded(settings);
  });
  // register ipc services routes
  registerIpcMain(ipcRoutes);

  return { unsubscribe };
};

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app
  .whenReady()
  .then(async () => {
    electronApp.setAppUserModelId('com.electron');

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    await initializeApp();

    logger.info('app.whenReady end');
  })

  .catch(console.log);
