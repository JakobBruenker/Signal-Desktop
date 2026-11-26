// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Browser replacement for ts/services/calling.preload.ts: `calling` forwards
// method calls to the backend's calling service (which owns RingRTC). Calls
// themselves aren't supported in browser tabs yet; this covers what other UI
// uses, like listing audio/video devices in settings.

import type { calling as backendCalling } from '../../services/calling.preload.ts';
import { remoteFunction } from './remoteModule.std.ts';

const methods = new Map<string, unknown>();

export const calling = new Proxy({} as typeof backendCalling, {
  get(_target, name) {
    if (typeof name !== 'string' || name === 'then') {
      return undefined;
    }
    let method = methods.get(name);
    if (!method) {
      method = remoteFunction('calling', name);
      methods.set(name, method);
    }
    return method;
  },
});
