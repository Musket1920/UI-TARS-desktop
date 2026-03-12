/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLocalhostOpenAICompatibleFixture,
  type LocalhostOpenAICompatibleFixture,
  type LocalhostOpenAICompatibleFixtureState,
} from '../testing/localhostOpenAICompatibleFixture';

const { settingStoreSetMock } = vi.hoisted(() => ({
  settingStoreSetMock: vi.fn(),
}));

vi.mock('@main/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock('@main/store/setting', () => ({
  SettingStore: {
    set: settingStoreSetMock,
  },
}));

import { settingRoute } from './setting';

type SettingRouteContext = Parameters<
  typeof settingRoute.testLocalVLMConnection.handle
>[0]['context'];

let fixture: LocalhostOpenAICompatibleFixture | null = null;

const createFixture = async (
  state: LocalhostOpenAICompatibleFixtureState,
  overrides: Partial<LocalhostOpenAICompatibleFixture['input']> = {},
) => {
  fixture = await createLocalhostOpenAICompatibleFixture(state, overrides);
  return {
    ...fixture.input,
    ...overrides,
  };
};

const getFixturePaths = () => {
  return fixture?.requests.map((request) => request.path) ?? [];
};

const invalidInput = {
  baseUrl: 'localhost:11434/v1',
  apiKey: '',
  modelName: 'ui-tars-1.5-7b',
};

describe('settingRoute.checkModelAvailability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (fixture !== null) {
      await fixture.close();
      fixture = null;
    }
  });

  it('uses the localhost fixture chat success path', async () => {
    const input = await createFixture('chat-success');

    await expect(
      settingRoute.checkModelAvailability.handle({
        input,
        context: {} as SettingRouteContext,
      }),
    ).resolves.toBe(true);
    expect(getFixturePaths()).toEqual(['/v1/chat/completions']);
  });
});

describe('settingRoute.checkVLMResponseApiSupport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (fixture !== null) {
      await fixture.close();
      fixture = null;
    }
  });

  it('returns true when the localhost fixture supports /responses', async () => {
    const input = await createFixture('responses-supported');

    await expect(
      settingRoute.checkVLMResponseApiSupport.handle({
        input,
        context: {} as SettingRouteContext,
      }),
    ).resolves.toBe(true);
    expect(getFixturePaths()).toEqual(['/v1/responses']);
  });

  it('returns false when the localhost fixture returns malformed responses payloads', async () => {
    const input = await createFixture('malformed-payload');

    await expect(
      settingRoute.checkVLMResponseApiSupport.handle({
        input,
        context: {} as SettingRouteContext,
      }),
    ).resolves.toBe(false);
    expect(getFixturePaths()).toEqual(['/v1/responses']);
  });
});

describe('settingRoute.testLocalVLMConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (fixture !== null) {
      await fixture.close();
      fixture = null;
    }
  });

  it('classifies invalid URLs without probing or persisting', async () => {
    const result = await settingRoute.testLocalVLMConnection.handle({
      input: invalidInput,
      context: {} as SettingRouteContext,
    });

    expect(result).toEqual({
      ok: false,
      modelAvailable: false,
      useResponsesApi: false,
      errorCode: 'INVALID_URL',
      errorMessage: 'Invalid base URL. Use a full http(s) URL.',
    });
    expect(getFixturePaths()).toEqual([]);
    expect(settingStoreSetMock).not.toHaveBeenCalled();
  });

  it('classifies unreachable hosts from the chat-completions probe', async () => {
    const result = await settingRoute.testLocalVLMConnection.handle({
      input: await createFixture('unreachable-host'),
      context: {} as SettingRouteContext,
    });

    expect(result).toEqual({
      ok: false,
      modelAvailable: false,
      useResponsesApi: false,
      errorCode: 'UNREACHABLE',
      errorMessage: 'Connection error.',
    });
    expect(getFixturePaths()).toEqual([]);
    expect(settingStoreSetMock).not.toHaveBeenCalled();
  });

  it('classifies missing models from the chat-completions probe', async () => {
    const result = await settingRoute.testLocalVLMConnection.handle({
      input: await createFixture('invalid-model', {
        modelName: 'missing-model',
      }),
      context: {} as SettingRouteContext,
    });

    expect(result).toEqual({
      ok: false,
      modelAvailable: false,
      useResponsesApi: false,
      errorCode: 'MODEL_NOT_FOUND',
      errorMessage: expect.stringContaining(
        'The model `missing-model` does not exist',
      ),
    });
    expect(getFixturePaths()).toEqual(['/v1/chat/completions']);
    expect(settingStoreSetMock).not.toHaveBeenCalled();
  });

  it('persists false when chat works but the responses API is unsupported', async () => {
    const result = await settingRoute.testLocalVLMConnection.handle({
      input: await createFixture('responses-unsupported'),
      context: {} as SettingRouteContext,
    });

    expect(result).toEqual({
      ok: true,
      modelAvailable: true,
      useResponsesApi: false,
      errorCode: 'RESPONSES_UNSUPPORTED',
      errorMessage: expect.stringContaining('404 Not Found for POST /responses'),
    });
    expect(getFixturePaths()).toEqual([
      '/v1/chat/completions',
      '/v1/responses',
    ]);
    expect(settingStoreSetMock).toHaveBeenCalledTimes(1);
    expect(settingStoreSetMock).toHaveBeenCalledWith('useResponsesApi', false);
  });

  it('falls back to UNKNOWN for malformed localhost payloads without persisting', async () => {
    const result = await settingRoute.testLocalVLMConnection.handle({
      input: await createFixture('malformed-payload'),
      context: {} as SettingRouteContext,
    });

    expect(result).toEqual({
      ok: false,
      modelAvailable: false,
      useResponsesApi: false,
      errorCode: 'UNKNOWN',
      errorMessage: expect.stringContaining('invalid json response body'),
    });
    expect(getFixturePaths()).toEqual(['/v1/chat/completions']);
    expect(settingStoreSetMock).not.toHaveBeenCalled();
  });

  it('persists true when both probes succeed', async () => {
    const result = await settingRoute.testLocalVLMConnection.handle({
      input: await createFixture('responses-supported'),
      context: {} as SettingRouteContext,
    });

    expect(result).toEqual({
      ok: true,
      modelAvailable: true,
      useResponsesApi: true,
      errorCode: null,
      errorMessage: null,
    });
    expect(getFixturePaths()).toEqual([
      '/v1/chat/completions',
      '/v1/responses',
    ]);
    expect(settingStoreSetMock).toHaveBeenCalledTimes(1);
    expect(settingStoreSetMock).toHaveBeenCalledWith('useResponsesApi', true);
  });
});
