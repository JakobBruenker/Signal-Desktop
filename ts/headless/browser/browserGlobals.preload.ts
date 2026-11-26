// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Node-style globals the UI code reads. Imported first by the browser entry.

import { Buffer } from 'node:buffer';

import { bootData } from './electronShim.dom.ts';

const g = globalThis as unknown as Record<string, unknown>;

g.global ??= globalThis;
g.Buffer ??= Buffer;
g.process ??= {
  // The backend's platform: the UI adapts to it (keyboard shortcuts, ...)
  platform: bootData.platform,
  env: {},
  versions: {},
  argv: [],
  browser: true,
  cwd: () => '/',
  nextTick: (fn: (...args: Array<unknown>) => void, ...args: Array<unknown>) =>
    queueMicrotask(() => fn(...args)),
};

// Full stacks for uncaught errors (the default console line lacks them)
window.addEventListener('error', event => {
  // oxlint-disable-next-line no-console
  console.error('uncaught:', event.error?.stack ?? event.message);
});
window.addEventListener('unhandledrejection', event => {
  const { reason } = event;
  // oxlint-disable-next-line no-console
  console.error('unhandled rejection:', reason?.stack ?? reason);
});
