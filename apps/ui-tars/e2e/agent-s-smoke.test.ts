/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ElectronApplication,
  Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test';
import { findLatestBuild, parseElectronApp } from 'electron-playwright-helpers';

type AgentSFixtureScenario = 'healthy' | 'fallback';

const FIXTURE_VLM_SETTINGS = {
  operator: 'Local Computer Operator',
  vlmApiKey: 'fixture-api-key',
  vlmBaseUrl: 'https://example.com/v1',
  vlmModelName: 'fixture-model',
  vlmProvider: 'Hugging Face for UI-TARS-1.5',
};

const EVIDENCE_DIR = resolve(__dirname, '../../../../.sisyphus/evidence');

const ensureEvidenceDir = () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
};

const evidencePath = (filename: string) => {
  ensureEvidenceDir();
  return resolve(EVIDENCE_DIR, filename);
};

const createFixturePayload = (scenario: AgentSFixtureScenario) => {
  const timestamp = Date.now();

  if (scenario === 'healthy') {
    return {
      health: {
        status: 'healthy',
        message: 'Agent-S is healthy.',
        reasonCode: 'ok',
        failureClass: null,
        circuitBreaker: {
          state: 'closed',
          open: false,
          canProbe: false,
          nextProbeAt: null,
        },
        engine: {
          mode: 'agent-s',
          runtime: 'agent-s',
          active: true,
          paused: false,
          thinking: false,
        },
        timestamp,
      },
      runtime: {
        status: 'running',
        engine: {
          mode: 'agent-s',
          runtime: 'agent-s',
          active: true,
          paused: false,
          thinking: false,
        },
        controls: {
          canRun: true,
          canPause: true,
          canResume: false,
          canStop: true,
        },
        timestamp,
      },
    };
  }

  return {
    health: {
      status: 'offline',
      message: 'Agent-S is unavailable. Legacy fallback is active.',
      reasonCode: 'startup_failed',
      failureClass: 'unavailable',
      circuitBreaker: {
        state: 'open',
        open: true,
        canProbe: false,
        nextProbeAt: timestamp + 10_000,
      },
      engine: {
        mode: 'agent-s',
        runtime: 'legacy',
        active: false,
        paused: false,
        thinking: false,
      },
      timestamp,
    },
    runtime: {
      status: 'idle',
      engine: {
        mode: 'agent-s',
        runtime: 'legacy',
        active: false,
        paused: false,
        thinking: false,
      },
      controls: {
        canRun: true,
        canPause: false,
        canResume: false,
        canStop: false,
      },
      timestamp,
    },
  };
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

  const page = await electronApp.firstWindow();
  return { electronApp, page };
};

const installAgentSFixtureHandlers = async (
  electronApp: ElectronApplication,
  scenario: AgentSFixtureScenario,
) => {
  await electronApp.evaluate(
    ({ ipcMain }, payload) => {
      const fixtureScenario = payload.scenario;
      const fixtureSettings = payload.settings;

      const createPayload = (kind: AgentSFixtureScenario) => {
        const timestamp = Date.now();
        if (kind === 'healthy') {
          return {
            health: {
              status: 'healthy',
              message: 'Agent-S is healthy.',
              reasonCode: 'ok',
              failureClass: null,
              circuitBreaker: {
                state: 'closed',
                open: false,
                canProbe: false,
                nextProbeAt: null,
              },
              engine: {
                mode: 'agent-s',
                runtime: 'agent-s',
                active: true,
                paused: false,
                thinking: false,
              },
              timestamp,
            },
            runtime: {
              status: 'running',
              engine: {
                mode: 'agent-s',
                runtime: 'agent-s',
                active: true,
                paused: false,
                thinking: false,
              },
              controls: {
                canRun: true,
                canPause: true,
                canResume: false,
                canStop: true,
              },
              timestamp,
            },
          };
        }

        return {
          health: {
            status: 'offline',
            message: 'Agent-S is unavailable. Legacy fallback is active.',
            reasonCode: 'startup_failed',
            failureClass: 'unavailable',
            circuitBreaker: {
              state: 'open',
              open: true,
              canProbe: false,
              nextProbeAt: timestamp + 10_000,
            },
            engine: {
              mode: 'agent-s',
              runtime: 'legacy',
              active: false,
              paused: false,
              thinking: false,
            },
            timestamp,
          },
          runtime: {
            status: 'idle',
            engine: {
              mode: 'agent-s',
              runtime: 'legacy',
              active: false,
              paused: false,
              thinking: false,
            },
            controls: {
              canRun: true,
              canPause: false,
              canResume: false,
              canStop: false,
            },
            timestamp,
          },
        };
      };

      ipcMain.removeHandler('getAgentSHealth');
      ipcMain.removeHandler('getAgentRuntimeStatus');
      ipcMain.removeHandler('runAgent');
      ipcMain.removeHandler('stopRun');
      ipcMain.removeHandler('setting:get');

      ipcMain.handle('getAgentSHealth', async () => {
        return createPayload(fixtureScenario).health;
      });

      ipcMain.handle('getAgentRuntimeStatus', async () => {
        return createPayload(fixtureScenario).runtime;
      });

      ipcMain.handle('runAgent', async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 1200);
        });
      });

      ipcMain.handle('stopRun', async () => {
        return;
      });

      ipcMain.handle('setting:get', async () => {
        return fixtureSettings;
      });
    },
    {
      scenario,
      settings: FIXTURE_VLM_SETTINGS,
    },
  );
};

const openLocalSession = async (page: Page) => {
  const localComputerButton = page.getByRole('button', {
    name: 'Use Local Computer',
  });
  await expect(localComputerButton).toBeVisible();
  await localComputerButton.click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('#/local');
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });
};

const runAgentFromInput = async (page: Page) => {
  const chatInput = page.getByTestId('chat-input');
  const runButton = page.getByTestId('run-agent-btn');
  const runStatus = page.getByTestId('run-status');

  await expect(runStatus).toHaveAttribute('data-status', 'idle');
  await chatInput.fill('fixture smoke run flow');
  await expect(runButton).toBeEnabled();
  await runButton.click();

  await expect
    .poll(async () => runStatus.getAttribute('data-status'))
    .toBe('running');
  await expect
    .poll(async () => runStatus.getAttribute('data-status'))
    .toBe('idle');
};

const openEngineSettings = async (page: Page) => {
  await page
    .getByRole('button', { name: /^settings$/i })
    .first()
    .click();
  await page.getByRole('tab', { name: 'Engine Settings' }).click();
  await expect(page.getByTestId('engine-select')).toBeVisible();
};

const selectAgentSEngine = async (page: Page) => {
  const engineSelect = page.getByRole('combobox', { name: 'Engine Mode' });
  await engineSelect.click();

  const listbox = page
    .getByRole('listbox')
    .filter({ hasText: 'Agent-S (Sidecar)' })
    .first();
  await expect(listbox).toBeVisible();

  const agentSOption = listbox.getByRole('option', {
    name: 'Agent-S (Sidecar)',
  });
  await expect(agentSOption).toBeVisible();
  await agentSOption.scrollIntoViewIfNeeded();
  await agentSOption.focus();
  await page.keyboard.press('Enter');

  await expect(listbox).toBeHidden();
};

test('@agent-s-healthy smoke healthy path shows Agent-S runtime indicators', async () => {
  test.setTimeout(90_000);
  const { electronApp, page } = await launchApp();

  try {
    const fixture = createFixturePayload('healthy');
    await page.waitForLoadState('domcontentloaded', { timeout: 0 });
    await installAgentSFixtureHandlers(electronApp, 'healthy');
    await expect(
      page.getByRole('button', { name: /^settings$/i }).first(),
    ).toBeVisible();

    await openLocalSession(page);
    await runAgentFromInput(page);

    await openEngineSettings(page);
    await selectAgentSEngine(page);

    await expect(page.getByTestId('engine-select')).toContainText('Agent-S');
    await expect(page.getByTestId('agent-s-health-badge')).toContainText(
      'healthy',
    );
    await expect(
      page.getByText('Runtime: Agent-S runtime active'),
    ).toBeVisible();
    await expect(
      page.getByText(`Controls: ${fixture.runtime.status}`),
    ).toBeVisible();
    await expect(page.getByTestId('engine-fallback-status')).toHaveCount(0);

    await page.screenshot({
      path: evidencePath('task-15-e2e-agent-s-healthy.png'),
      fullPage: true,
    });
  } finally {
    await electronApp.close();
  }
});

test('@agent-s-fallback smoke degraded path shows fallback and legacy operability', async () => {
  test.setTimeout(90_000);
  const { electronApp, page } = await launchApp();

  try {
    const fixture = createFixturePayload('fallback');
    await page.waitForLoadState('domcontentloaded', { timeout: 0 });
    await installAgentSFixtureHandlers(electronApp, 'fallback');
    await expect(
      page.getByRole('button', { name: /^settings$/i }).first(),
    ).toBeVisible();

    await openLocalSession(page);
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.getByTestId('run-agent-btn')).toBeVisible();
    await expect(page.getByTestId('run-status')).toHaveAttribute(
      'data-status',
      'idle',
    );

    await openEngineSettings(page);
    await selectAgentSEngine(page);

    await expect(page.getByTestId('agent-s-health-badge')).toContainText(
      'offline',
    );
    const fallbackStatus = page.getByTestId('engine-fallback-status');
    await expect(fallbackStatus).toContainText(/Agent-S sidecar offline/i);
    await expect(fallbackStatus).toContainText(/legacy path/i);
    await expect(
      page.getByText('Runtime: Legacy runtime in use'),
    ).toBeVisible();
    await expect(
      page.getByText(`Controls: ${fixture.runtime.status}`),
    ).toBeVisible();

    await page.screenshot({
      path: evidencePath('task-15-e2e-fallback.png'),
      fullPage: true,
    });
  } finally {
    await electronApp.close();
  }
});
