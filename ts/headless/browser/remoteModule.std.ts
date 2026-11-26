// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Calls a function of a backend module registered in
// ts/headless/backendModules.preload.ts.

import { callBackend } from './backendClient.std.ts';

export function remoteFunction<Fn extends (...args: Array<never>) => unknown>(
  module: string,
  name: string
): (...args: Parameters<Fn>) => Promise<unknown> {
  return async (...args) => callBackend('/api/module', { module, name, args });
}
