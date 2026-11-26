// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { Middleware, Store } from 'redux';

import type { StateType } from '../state/reducer.preload.ts';

// Present as `window.SignalHeadless` when the main window's renderer code runs
// headless inside the main process (see app/headless/HeadlessHost.main.ts).
// The UI is then rendered by connected browser tabs instead.
export type SignalHeadlessHooks = Readonly<{
  // Installed last in the redux middleware chain, so it only sees the plain
  // actions that reach the reducers (after thunks and promises resolve).
  reduxMiddleware: Middleware;
  onAppReady: (store: Store<StateType>) => void;
}>;
