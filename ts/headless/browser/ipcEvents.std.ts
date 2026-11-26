// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// `window.Events` for browser tabs: settings getters/setters and app actions
// (ts/util/createIPCEvents.preload.ts) run on the backend's instance, so
// every call returns a promise. Zoom is the browser's own, so zoom change
// listeners are only kept for the API's sake.

import type { IPCEventsType } from '../../util/createIPCEvents.preload.ts';
import { remoteFunction } from './remoteModule.std.ts';

const LOCAL: Record<string, unknown> = {
  onZoomFactorChange: () => undefined,
  offZoomFactorChange: () => undefined,
};

export function createBrowserIPCEvents(): IPCEventsType {
  const methods = new Map<string, unknown>();
  return new Proxy({} as IPCEventsType, {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') {
        return undefined;
      }
      if (Object.hasOwn(LOCAL, name)) {
        return LOCAL[name];
      }
      let method = methods.get(name);
      if (!method) {
        method = remoteFunction('Events', name);
        methods.set(name, method);
      }
      return method;
    },
  });
}
