/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  ElectronApplication,
  Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test';
import { findLatestBuild, parseElectronApp } from 'electron-playwright-helpers';

import {
  createLocalhostOpenAICompatibleFixture,
  type LocalhostOpenAICompatibleFixture,
} from '../src/main/testing/localhostOpenAICompatibleFixture';

const LOCALHOST_MODE_LABEL = 'Localhost (OpenAI-compatible)';
const PROVIDER_LABEL = 'Hugging Face for UI-TARS-1.5';
const LOCAL_COMPUTER_OPERATOR = 'Local Computer Operator';

type PersistedSettings = Record<string, unknown>;

type SmokeHarnessState = {
  runInvocationCount: number;
  capturedSettings: PersistedSettings | null;
};

const launchApp = async (): Promise<{
  electronApp: ElectronApplication;
  page: Page;
}> => {
  const latestBuild = findLatestBuild();
  const { executable: executablePath, main } = parseElectronApp(latestBuild);

  const electronApp = await electron.launch({
    args: [main],
    executablePath,
    env: {
      ...process.env,
      CI: 'e2e',
    },
  });

  await electronApp.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows().find((window) => {
      return !window.isDestroyed();
    });

    mainWindow?.setSize(1600, 1400);
    mainWindow?.center();
  });

  const page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1600, height: 1400 });
  return { electronApp, page };
};

const installSmokeHarness = async (electronApp: ElectronApplication) => {
  await electronApp.evaluate(({ BrowserWindow, ipcMain }) => {
    const globalState = globalThis as typeof globalThis & {
      __localhostProviderSmoke?: SmokeHarnessState;
    };

    globalState.__localhostProviderSmoke = {
      runInvocationCount: 0,
      capturedSettings: null,
    };

    ipcMain.removeHandler('runAgent');
    ipcMain.removeHandler('stopRun');
    ipcMain.removeHandler('localhost-provider:getSmokeState');

    ipcMain.handle('runAgent', async () => {
      globalState.__localhostProviderSmoke!.runInvocationCount += 1;

      const mainWindow = BrowserWindow.getAllWindows().find((window) => {
        return !window.isDestroyed();
      });

      if (mainWindow) {
        globalState.__localhostProviderSmoke!.capturedSettings =
          (await mainWindow.webContents.executeJavaScript(
            'window.electron.setting.getSetting()',
            true,
          )) as PersistedSettings;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 1200);
      });
    });

    ipcMain.handle('stopRun', async () => {
      return;
    });

    ipcMain.handle('localhost-provider:getSmokeState', async () => {
      return globalState.__localhostProviderSmoke;
    });
  });
};

const clearPersistedSettings = async (page: Page) => {
  await page.evaluate(async () => {
    const electronWindow = window as unknown as Window & {
      electron: {
        setting: {
          clearSetting: () => Promise<void>;
        };
      };
    };

    await electronWindow.electron.setting.clearSetting();
  });
};

const getPersistedSettings = async (page: Page): Promise<PersistedSettings> => {
  return await page.evaluate(async () => {
    const electronWindow = window as unknown as Window & {
      electron: {
        setting: {
          getSetting: () => Promise<PersistedSettings>;
        };
      };
    };

    return await electronWindow.electron.setting.getSetting();
  });
};

const invokeRendererChannel = async <T>(
  page: Page,
  channel: string,
): Promise<T> => {
  return await page.evaluate(async (invokeChannel) => {
    const electronWindow = window as unknown as Window & {
      electron: {
        ipcRenderer: {
          invoke: (channelName: string) => Promise<T>;
        };
      };
    };

    return await electronWindow.electron.ipcRenderer.invoke(invokeChannel);
  }, channel);
};

const waitForPermissions = async (page: Page) => {
  await expect
    .poll(async () => {
      return await page.evaluate(async () => {
        const electronWindow = window as unknown as Window & {
          zustandBridge: {
            getState: () => Promise<{
              ensurePermissions?: {
                accessibility?: boolean;
                screenCapture?: boolean;
              };
            }>;
          };
        };

        const state = await electronWindow.zustandBridge.getState();
        return (
          state.ensurePermissions?.accessibility === true &&
          state.ensurePermissions?.screenCapture === true
        );
      });
    })
    .toBe(true);
};

const selectOption = async (
  page: Page,
  triggerTestId: string,
  optionName: string,
) => {
  await page.getByTestId(triggerTestId).click();

  const option = page.getByRole('option', { name: optionName }).first();
  await expect(option).toBeVisible();
  await option.click();
};

const selectLocalhostMode = async (page: Page) => {
  await selectOption(page, 'connection-mode', LOCALHOST_MODE_LABEL);
  await selectOption(page, 'vlm-provider', PROVIDER_LABEL);
};

const fillLocalhostSettings = async (
  page: Page,
  fixture: LocalhostOpenAICompatibleFixture,
) => {
  await page.getByTestId('vlm-base-url').fill(fixture.input.baseUrl);
  await page.getByTestId('vlm-api-key').fill(fixture.input.apiKey);
  await page.getByTestId('vlm-model-name').fill(fixture.input.modelName);
};

const openLocalComputerSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'Use Local Computer' }).click();
  await expect(page.getByRole('heading', { name: 'VLM Settings' })).toBeVisible();
};

test('@localhost-provider smoke localhost settings gate persists success and rejects unreachable hosts', async () => {
  test.setTimeout(120_000);

  const unreachableFixture = await createLocalhostOpenAICompatibleFixture(
    'unreachable-host',
  );
  const supportedFixture = await createLocalhostOpenAICompatibleFixture(
    'responses-supported',
  );

  const { electronApp, page } = await launchApp();

  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 0 });
    await installSmokeHarness(electronApp);
    await clearPersistedSettings(page);

    const initialSettings = await getPersistedSettings(page);

    await openLocalComputerSettings(page);
    await selectLocalhostMode(page);
    await fillLocalhostSettings(page, unreachableFixture);
    await page.getByTestId('test-connection').click({ force: true });

    await expect(
      page.getByText('Cannot reach the localhost server'),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Cannot reach this localhost endpoint. Verify the server is running and the URL is correct.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Get Start' })).toBeDisabled();

    const persistedAfterFailure = await getPersistedSettings(page);
    expect(persistedAfterFailure).toEqual(initialSettings);

    await fillLocalhostSettings(page, supportedFixture);
    await page.getByTestId('test-connection').click({ force: true });

    await expect(page.getByText('Connected to localhost')).toBeVisible();
    await expect(
      page.getByText('Detected capability: Responses API supported.'),
    ).toBeVisible();

    const getStartButton = page.getByRole('button', { name: 'Get Start' });
    await expect(getStartButton).toBeEnabled();
    await getStartButton.click({ force: true });

    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('#/local');
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(async () => {
        const settings = await getPersistedSettings(page);
        return settings.operator;
      })
      .toBe(LOCAL_COMPUTER_OPERATOR);

    const persistedAfterSuccess = await getPersistedSettings(page);
    expect(persistedAfterSuccess).toMatchObject({
      operator: LOCAL_COMPUTER_OPERATOR,
      useResponsesApi: true,
      vlmApiKey: supportedFixture.input.apiKey,
      vlmBaseUrl: supportedFixture.input.baseUrl,
      vlmConnectionMode: 'localhost-openai-compatible',
      vlmModelName: supportedFixture.input.modelName,
      vlmProvider: PROVIDER_LABEL,
    });

    await invokeRendererChannel(page, 'getEnsurePermissions');
    await waitForPermissions(page);

    const chatInput = page.getByTestId('chat-input');
    const runButton = page.getByTestId('run-agent-btn');
    const runStatus = page.getByTestId('run-status');

    await chatInput.fill('localhost provider smoke run');
    await expect(runButton).toBeEnabled();
    await invokeRendererChannel(page, 'runAgent');
    await expect(runStatus).toHaveAttribute('data-status', 'idle');

    const smokeState = await invokeRendererChannel<SmokeHarnessState>(
      page,
      'localhost-provider:getSmokeState',
    );

    expect(smokeState.runInvocationCount).toBe(1);
    expect(smokeState.capturedSettings).toMatchObject({
      operator: LOCAL_COMPUTER_OPERATOR,
      useResponsesApi: true,
      vlmBaseUrl: supportedFixture.input.baseUrl,
      vlmConnectionMode: 'localhost-openai-compatible',
      vlmModelName: supportedFixture.input.modelName,
    });
  } finally {
    await supportedFixture.close();
    await unreachableFixture.close();
    await electronApp.close();
  }
});
