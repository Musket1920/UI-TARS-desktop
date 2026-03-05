/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { ElectronHandler } from '../../../preload/index';
import type { AppState } from '@main/store/types';

type ZustandBridge = {
  getState: () => Promise<AppState>;
  subscribe: (callback: (newState: AppState) => void) => () => void;
};

declare global {
  // eslint-disable-next-line no-unused-vars
  interface Window {
    electron: ElectronHandler;
    platform: NodeJS.Platform;
    zustandBridge: ZustandBridge;
  }
}

export {};
