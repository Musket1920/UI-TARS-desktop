/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { permissionRoute } from './permission';
import { store } from '@main/store/create';
import { describe, expect, it, vi, beforeEach } from 'vitest';

type GetEnsurePermissionsContext = Parameters<
  typeof permissionRoute.getEnsurePermissions.handle
>[0]['context'];

vi.mock('@main/env', () => ({
  isMacOS: true,
}));

vi.mock('@main/store/create', () => ({
  store: {
    setState: vi.fn(),
    getState: vi.fn(() => ({
      ensurePermissions: { screenCapture: true, accessibility: true },
    })),
  },
}));

vi.mock('@main/utils/systemPermissions', () => ({
  ensurePermissions: vi.fn(() => ({
    screenCapture: true,
    accessibility: true,
  })),
}));

const mockEnsurePermissions = async () =>
  vi.mocked((await import('@main/utils/systemPermissions')).ensurePermissions);

const mockStoreSetState = vi.mocked(store.setState);
const mockStoreGetState = vi.mocked(store.getState);

describe('permissionRoute.getEnsurePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('should handle MacOS permission check errors', async () => {
    const ensurePermissionsMock = await mockEnsurePermissions();
    ensurePermissionsMock.mockImplementation(() => {
      throw new Error('Failed to check system permissions');
    });

    await expect(
      permissionRoute.getEnsurePermissions.handle({
        input: undefined,
        context: {} as GetEnsurePermissionsContext,
      }),
    ).rejects.toThrow('Failed to check system permissions');
  });

  it('should handle store state update errors', async () => {
    const ensurePermissionsMock = await mockEnsurePermissions();
    ensurePermissionsMock.mockReturnValue({
      screenCapture: true,
      accessibility: true,
    });

    mockStoreSetState.mockImplementationOnce(() => {
      throw new Error('Failed to update store state');
    });

    await expect(
      permissionRoute.getEnsurePermissions.handle({
        input: undefined,
        context: {} as GetEnsurePermissionsContext,
      }),
    ).rejects.toThrow('Failed to update store state');
  });

  it('should handle store getState errors', async () => {
    const ensurePermissionsMock = await mockEnsurePermissions();
    ensurePermissionsMock.mockReturnValue({
      screenCapture: true,
      accessibility: true,
    });

    mockStoreGetState.mockImplementationOnce(() => {
      throw new Error('Failed to get store state');
    });

    await expect(
      permissionRoute.getEnsurePermissions.handle({
        input: undefined,
        context: {} as GetEnsurePermissionsContext,
      }),
    ).rejects.toThrow('Failed to get store state');
  });

  it('should handle invalid permission response format', async () => {
    const ensurePermissionsMock = await mockEnsurePermissions();
    ensurePermissionsMock.mockReturnValue({
      screenCapture: true,
      accessibility: true,
    });

    mockStoreGetState.mockReturnValue({
      ensurePermissions: { screenCapture: true, accessibility: true },
    } as ReturnType<typeof store.getState>);

    const result = await permissionRoute.getEnsurePermissions.handle({
      input: undefined,
      context: {} as GetEnsurePermissionsContext,
    });

    expect(result).toEqual({
      screenCapture: true,
      accessibility: true,
    });
  });
});
