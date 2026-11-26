// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { Middleware, Store } from 'redux';

import type { StateType } from '../state/reducer.preload.ts';
import type { HeadlessBackendModules } from './backendModules.preload.ts';

// Present as `window.SignalHeadless` when the main window's renderer code runs
// headless inside the main process (see app/headless/HeadlessHost.main.ts).
// The UI is then rendered by connected browser tabs instead.
export type SignalHeadlessHooks = Readonly<{
  // Installed last in the redux middleware chain, so it only sees the plain
  // actions that reach the reducers (after thunks and promises resolve).
  reduxMiddleware: Middleware;
  // Sounds play in browser tabs (see ts/headless/backend/sound.dom.ts)
  playSound: (
    sound: Readonly<{ id: string; src: string; loop: boolean }>
  ) => void;
  stopSound: (id: string) => void;
  // Loads attachment:/asset:/emoji: URLs through main's protocol handlers
  fetchLocalResource: (url: string) => Promise<ArrayBuffer>;
  // Runs work that needs a real browser (e.g. video decoding) in a connected
  // tab; see app/headless/TabJobs.node.ts and ts/headless/browser/tabJobs.dom.ts
  // `input` is a Blob or an attachment:// (etc.) URL.
  runInTab: (
    kind: string,
    args: unknown,
    input: Blob | string,
    options?: Readonly<{ timeoutMs?: number }>
  ) => Promise<unknown>;
  onAppReady: (
    store: Store<StateType>,
    modules: HeadlessBackendModules
  ) => void;
}>;
